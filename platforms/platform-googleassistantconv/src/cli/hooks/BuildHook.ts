import { existsSync, mkdirSync, rmdirSync, writeFileSync } from 'fs';
import { join as joinPaths } from 'path';
import _merge from 'lodash.merge';
import _get from 'lodash.get';
import _has from 'lodash.has';
import _mergeWith from 'lodash.mergewith';
import _set from 'lodash.set';
import _uniq from 'lodash.uniq';
import * as yaml from 'yaml';
import {
  Task,
  PluginContext,
  JovoCliError,
  printStage,
  printSubHeadline,
  OK_HAND,
  STATION,
  PluginHook,
  JovoCli,
  wait,
  mergeArrayCustomizer,
  flags,
  deleteFolderRecursive,
  printHighlight,
  InstallContext,
} from '@jovotech/cli-core';
import { BuildContext, BuildEvents, ParseContextBuild } from '@jovotech/cli-command-build';
import { FileBuilder, FileObject } from '@jovotech/filebuilder';
import { JovoModelData, NativeFileInformation } from 'jovo-model';
import { JovoModelGoogle } from 'jovo-model-google';

import defaultFiles from '../utils/DefaultFiles.json';
import {
  GoogleActionActions,
  getPlatformDirectory,
  getPlatformPath,
  PluginContextGoogle,
  PluginConfigGoogle,
} from '../utils';
import SUPPORTED_LOCALES from '../utils/SupportedLocales.json';

export interface BuildContextGoogle extends BuildContext, PluginContextGoogle {
  flags: BuildContext['flags'] & { 'project-id'?: string };
  defaultLocale?: string;
}

export class BuildHook extends PluginHook<BuildEvents> {
  $config!: PluginConfigGoogle;
  $context!: BuildContextGoogle;

  install() {
    this.actionSet = {
      'install': [this.addCliOptions.bind(this)],
      'parse': [this.checkForPlatform.bind(this)],
      'before.build': [
        this.updatePluginContext.bind(this),
        this.checkForCleanBuild.bind(this),
        this.validateLocales.bind(this),
        this.validateModels.bind(this),
      ],
      'build': [this.build.bind(this)],
      'reverse.build': [this.buildReverse.bind(this)],
    };
  }

  addCliOptions(context: InstallContext) {
    if (context.command !== 'build') {
      return;
    }

    context.flags['project-id'] = flags.string({
      description: 'Google Cloud Project ID',
    });
  }

  /**
   * Checks if the currently selected platform matches this CLI plugin.
   * @param context - Event arguments.
   */
  checkForPlatform(context: ParseContextBuild) {
    // Check if this plugin should be used or not.
    if (context.flags.platform && !context.flags.platform.includes(this.$plugin.id)) {
      this.uninstall();
    }
  }

  /**
   * Updates the current context with plugin-specific values from --project-id.
   */
  updatePluginContext() {
    if (this.$context.command !== 'build') {
      return;
    }

    this.$context.projectId = this.$context.flags['project-id'] || _get(this.$config, 'projectId');

    if (!this.$context.projectId) {
      throw new JovoCliError(
        'Could not find projectId.',
        this.$plugin.constructor.name,
        'Please provide a project id by using the flag "--project-id" or in your project configuration.',
      );
    }
  }

  checkForCleanBuild() {
    // If --clean has been set, delete the respective platform folders before building.
    if (this.$context.flags.clean) {
      deleteFolderRecursive(getPlatformPath());
    }
  }

  /**
   * Checks if any provided locale is not supported, thus invalid.
   */
  validateLocales() {
    const locales: string[] = this.$context.locales.reduce((locales: string[], locale: string) => {
      locales.push(...this.getResolvedLocales(locale));
      return locales;
    }, []);

    for (const locale of locales) {
      const genericLocale: string = locale.substring(0, 2);
      if (SUPPORTED_LOCALES.includes(genericLocale) && !locales.includes(genericLocale)) {
        throw new JovoCliError(
          `Locale ${printHighlight(locale)} requires a generic locale ${printHighlight(
            genericLocale,
          )}.`,
          this.$plugin.constructor.name,
        );
      }

      if (!SUPPORTED_LOCALES.includes(locale)) {
        throw new JovoCliError(
          `Locale ${printHighlight(locale)} is not supported by Google Conversational Actions.`,
          this.$plugin.constructor.name,
          'For more information on multiple language support: https://developers.google.com/assistant/console/languages-locales',
        );
      }
    }
  }

  async validateModels() {
    const jovo: JovoCli = JovoCli.getInstance();

    // Validate Jovo model.
    const validationTask: Task = new Task(`${OK_HAND} Validating Google Assistant model files`);

    for (const locale of this.$context.locales) {
      const localeTask = new Task(locale, async () => {
        jovo.$project!.validateModel(locale, JovoModelGoogle.getValidator());
        await wait(500);
      });

      validationTask.add(localeTask);
    }

    await validationTask.run();
  }

  /**
   * Main build function.
   */
  async build() {
    const jovo: JovoCli = JovoCli.getInstance();
    const taskStatus: string = jovo.$project!.hasPlatform(getPlatformDirectory())
      ? 'Updating'
      : 'Creating';

    const buildTaskTitle = `${STATION} ${taskStatus} Google Conversational Action project files${printStage(
      jovo.$project!.$stage,
    )}\n${printSubHeadline(
      `Path: ./${jovo.$project!.getBuildDirectory()}/${getPlatformDirectory()}`,
    )}`;
    // Define main build task.
    const buildTask: Task = new Task(buildTaskTitle);

    const resolvedLocales: string[] = this.$context.locales.reduce(
      (locales: string[], locale: string) => {
        locales.push(...this.getResolvedLocales(locale));
        return locales;
      },
      [],
    );
    this.$context.defaultLocale = this.getDefaultLocale(resolvedLocales);

    // Update or create Google Conversational Action project files, depending on whether it has already been built or not.
    const projectFilesTask: Task = new Task(
      `${taskStatus} Project Files`,
      this.createGoogleProjectFiles.bind(this),
    );

    const buildInteractionModelTask: Task = new Task(
      `${taskStatus} Interaction Model`,
      this.createInteractionModel(),
    );
    // If no model files for the current locales exist, do not build interaction model.
    if (!jovo.$project!.hasModelFiles(this.$context.locales)) {
      buildInteractionModelTask.disable();
    }

    buildTask.add(projectFilesTask, buildInteractionModelTask);

    await buildTask.run();
  }

  /**
   * Creates Google Conversational Action specific project files.
   */
  createGoogleProjectFiles() {
    const jovo: JovoCli = JovoCli.getInstance();
    const files: FileObject = FileBuilder.normalizeFileObject(_get(this.$config, 'files', {}));
    // If platforms folder doesn't exist, take default files and parse them with project.js config into FileBuilder.
    const projectFiles: FileObject = jovo.$project!.hasPlatform(getPlatformDirectory())
      ? files
      : _merge(defaultFiles, files);
    // Get default locale.
    // Merge global project.js properties with platform files.
    // Set endpoint.
    const endpoint: string = this.getPluginEndpoint();
    const webhookPath: string = 'webhooks/["ActionsOnGoogleFulfillment.yaml"]';

    if (endpoint && !_has(projectFiles, webhookPath)) {
      const defaultHandler = {
        handlers: [
          {
            name: 'Jovo',
          },
        ],
        httpsEndpoint: {
          baseUrl: this.getPluginEndpoint(),
        },
      };

      _set(projectFiles, webhookPath, defaultHandler);
    }

    // Set default settings, such as displayName.
    for (const locale of this.$context.locales) {
      const resolvedLocales: string[] = this.getResolvedLocales(locale);
      for (const resolvedLocale of resolvedLocales) {
        const settingsPathArr: string[] = ['settings/'];

        if (resolvedLocale !== this.$context.defaultLocale!) {
          settingsPathArr.push(`${resolvedLocale}/`);
        }

        settingsPathArr.push('["settings.yaml"]');

        const settingsPath: string = settingsPathArr.join('.');

        // Set default settings.
        if (resolvedLocale === this.$context.defaultLocale) {
          if (!_has(projectFiles, `${settingsPath}.defaultLocale`)) {
            _set(projectFiles, `${settingsPath}.defaultLocale`, this.$context.defaultLocale!);
          }

          if (!_has(projectFiles, `${settingsPath}.projectId`)) {
            _set(projectFiles, `${settingsPath}.projectId`, this.$context.projectId);
          }
        }

        // Set minimal required localized settings, such as displayName and pronunciation.
        const localizedSettingsPath: string = `${settingsPath}.localizedSettings`;

        const invocationName: string = this.getInvocationName(locale);
        if (!_has(projectFiles, `${localizedSettingsPath}.displayName`)) {
          _set(projectFiles, `${localizedSettingsPath}.displayName`, invocationName);
        }
        if (!_has(projectFiles, `${localizedSettingsPath}.pronunciation`)) {
          _set(projectFiles, `${localizedSettingsPath}.pronunciation`, invocationName);
        }
      }
    }

    FileBuilder.buildDirectory(projectFiles, getPlatformPath());
  }

  /**
   * Creates and returns tasks for each locale to build the interaction model for Google Assistant.
   */
  createInteractionModel(): Task[] {
    const tasks: Task[] = [];
    for (const locale of this.$context.locales) {
      const resolvedLocales: string[] = this.getResolvedLocales(locale);
      const localeTask: Task = new Task(`${locale} (${resolvedLocales.join(',')})`, async () => {
        this.buildLanguageModel(locale, resolvedLocales);
        await wait(500);
      });
      tasks.push(localeTask);
    }
    return tasks;
  }

  /**
   * Builds and saves Google Conversational Action model from Jovo model.
   * @param {string} locale
   * @param {string} stage
   */
  buildLanguageModel(modelLocale: string, resolvedLocales: string[]) {
    const model = this.getModel(modelLocale);

    for (const locale of resolvedLocales) {
      const jovoModel = new JovoModelGoogle(model, locale, this.$context.defaultLocale);
      const modelFiles: NativeFileInformation[] = jovoModel.exportNative()!;

      const actions: GoogleActionActions = {
        custom: {
          'actions.intent.MAIN': {},
        },
      };

      for (const file of modelFiles) {
        const fileName = file.path.pop()!;
        const modelPath = joinPaths(getPlatformPath(), ...file.path);

        // Check if the path for the current model type (e.g. intent, types, ...) exists.
        if (!existsSync(modelPath)) {
          mkdirSync(modelPath, { recursive: true });
        }

        // Register actions.
        if (file.path.includes('intents')) {
          actions.custom[fileName.replace('.yaml', '')] = {};
        }

        writeFileSync(joinPaths(modelPath, fileName), file.content);
      }

      // Merge existing actions file with configuration in project.js.
      _merge(actions, this.getProjectActions());

      const actionsPath: string = joinPaths(getPlatformPath(), 'actions');
      if (!existsSync(actionsPath)) {
        mkdirSync(actionsPath, { recursive: true });
      }
      writeFileSync(joinPaths(actionsPath, 'actions.yaml'), yaml.stringify(actions));
    }
  }

  /**
   * Gets configured actions from project.js
   */
  getProjectActions() {
    const actions = _get(this.$config, 'options.actions/');
    return actions;
  }

  /**
   * Gets the default locale for the current Conversational Action.
   * @param locales - An optional array of locales to choose the default locale from, if provided.
   */
  getDefaultLocale(locales?: string[]): string {
    const defaultLocale: string =
      _get(this.$config, 'files.settings/["settings.yaml"].defaultLocale') ||
      _get(this.$config, 'defaultLocale');

    if (!defaultLocale && locales) {
      // If locales includes an english model, take english as default automatically.
      for (const locale of locales) {
        if (locale.includes('en')) {
          return locale;
        }
      }

      // Otherwise take the first locale in the array as the default one.
      return locales[0];
    }

    if (!defaultLocale) {
      throw new JovoCliError(
        'Could not find a default locale.',
        this.$plugin.constructor.name,
        'Try adding the property "defaultLocale" to your project.js.',
      );
    }

    return defaultLocale;
  }

  /**
   * Try to get locale resolution (en -> en-US) from project.js.
   * @param locale - The locale to get the resolution from.
   */
  getProjectLocales(locale: string): string[] {
    return _get(this.$config, `options.locales.${locale}`) as string[];
  }

  /**
   * Get plugin-specific endpoint.
   */
  getPluginEndpoint(): string {
    const jovo: JovoCli = JovoCli.getInstance();
    const config = jovo.$project!.$config.get();
    const endpoint = _get(this.$config, 'endpoint') || _get(config, 'endpoint');

    return jovo.resolveEndpoint(endpoint);
  }

  /**
   * Gets the invocation name for the specified locale.
   * @param locale - The locale of the Jovo model to fetch the invocation name from.
   */
  getInvocationName(locale: string): string {
    const { invocation } = this.getModel(locale);

    if (typeof invocation === 'object') {
      // ToDo: Test!
      const platformInvocation: string = invocation[this.$plugin.constructor.name];

      if (!platformInvocation) {
        throw new JovoCliError(
          `Can\'t find invocation name for locale ${locale}.`,
          this.$plugin.constructor.name,
        );
      }

      return platformInvocation;
    }

    return invocation;
  }

  /**
   * Loads a Jovo model specified by a locale and merges it with plugin-specific models.
   * @param locale - The locale that specifies which model to load.
   */
  getModel(locale: string): JovoModelData {
    const jovo: JovoCli = JovoCli.getInstance();
    const model: JovoModelData = jovo.$project!.getModel(locale);

    // Merge model with configured language model in project.js.
    _mergeWith(
      model,
      jovo.$project!.$config.getParameter(`languageModel.${locale}`) || {},
      mergeArrayCustomizer,
    );
    // Merge model with configured, platform-specific language model in project.js.
    _mergeWith(model, _get(this.$config, `languageModel.${locale}`, {}), mergeArrayCustomizer);

    return model;
  }

  /**
   * Builds Jovo model files from platform-specific files.
   */
  async buildReverse(context: PluginContext) {
    const reverseBuildTask: Task = new Task('Reversing model files', () => {
      // ToDo: Implement!
    });

    await reverseBuildTask.run();
  }
}
