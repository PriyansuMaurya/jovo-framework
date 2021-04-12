import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from 'fs';
import _merge from 'lodash.merge';
import _get from 'lodash.get';
import _mergeWith from 'lodash.mergewith';
import _set from 'lodash.set';
import _has from 'lodash.has';
import {
  Task,
  JovoCliError,
  printStage,
  printSubHeadline,
  promptOverwriteReverseBuild,
  ANSWER_CANCEL,
  ANSWER_BACKUP,
  STATION,
  OK_HAND,
  PluginHook,
  JovoCli,
  wait,
  mergeArrayCustomizer,
  deleteFolderRecursive,
  printHighlight,
} from '@jovotech/cli-core';
import { BuildContext, BuildEvents, ParseContextBuild } from '@jovotech/cli-command-build';
import { FileBuilder, FileObject } from '@jovotech/filebuilder';
import { JovoModelAlexa, JovoModelAlexaData } from 'jovo-model-alexa';
import { JovoModelData, NativeFileInformation } from 'jovo-model';

import DefaultFiles from '../utils/DefaultFiles.json';
import {
  getModelPath,
  getModelsPath,
  getPlatformDirectory,
  getPlatformPath,
  PluginContextAlexa,
} from '../utils';

export interface BuildContextAlexa extends Omit<PluginContextAlexa, 'flags'>, BuildContext {}

export class BuildHook extends PluginHook<BuildEvents> {
  $context!: BuildContextAlexa;

  install() {
    this.actionSet = {
      'parse': [this.checkForPlatform.bind(this)],
      'before.build': [
        this.checkForCleanBuild.bind(this),
        this.validateLocales.bind(this),
        this.validateModels.bind(this),
      ],
      'build': [this.build.bind(this)],
      'reverse.build': [this.buildReverse.bind(this)],
    };
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
   * Checks if any provided locale is not supported, thus invalid.
   */
  validateLocales() {
    for (const locale of this.$context.locales) {
      const resolvedLocales: string[] = this.getResolvedLocales(locale);

      for (const resolvedLocale of resolvedLocales) {
        if (!this.$plugin.supportedLocales.includes(resolvedLocale)) {
          throw new JovoCliError(
            `Locale ${printHighlight(resolvedLocale)} is not supported by Amazon Alexa.`,
            this.$plugin.id,
            resolvedLocale.length === 2
              ? 'Alexa does not support generic locales, please specify locales in your project configuration.'
              : 'For more information on multiple language support: https://developer.amazon.com/en-US/docs/alexa/custom-skills/develop-skills-in-multiple-languages.html',
          );
        }
      }
    }
  }

  async validateModels() {
    const jovo: JovoCli = JovoCli.getInstance();
    // Validate Jovo model.
    const validationTask: Task = new Task(`${OK_HAND} Validating Alexa model files`);

    for (const locale of this.$context.locales) {
      const localeTask = new Task(locale, async () => {
        jovo.$project!.validateModel(locale, JovoModelAlexa.getValidator());
        await wait(500);
      });

      validationTask.add(localeTask);
    }

    await validationTask.run();
  }

  checkForCleanBuild() {
    // If --clean has been set, delete the respective platform folders before building.
    if (this.$context.flags.clean) {
      deleteFolderRecursive(getPlatformPath());
    }
  }

  async build() {
    const jovo: JovoCli = JovoCli.getInstance();
    const taskStatus: string = jovo.$project!.hasPlatform(getPlatformDirectory())
      ? 'Updating'
      : 'Creating';

    const buildTaskTitle =
      `${STATION} ${taskStatus} Alexa Skill project files${printStage(jovo.$project!.$stage)}\n` +
      printSubHeadline(`Path: ./${jovo.$project!.getBuildDirectory()}/${getPlatformDirectory()}`);

    // Define main build task.
    const buildTask: Task = new Task(buildTaskTitle);

    // Update or create Alexa project files, depending on whether it has already been built or not.
    const projectFilesTask: Task = new Task(
      `${taskStatus} Project Files`,
      this.createAlexaProjectFiles.bind(this),
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

  async buildReverse() {
    const jovo: JovoCli = JovoCli.getInstance();
    // Since platform can be prompted for, check if this plugin should actually be executed again.
    if (!this.$context.platforms.includes(this.$plugin.id)) {
      return;
    }
    // Get locales to reverse build from.
    // If --locale is not specified, reverse build from every locale available in the platform folder.
    const locales: string[] = [];
    const platformLocales: string[] = this.getPlatformLocales();
    if (!this.$context.flags.locale) {
      locales.push(...platformLocales);
    } else {
      // Otherwise only reverse build from the specified locale if it exists inside the platform folder.
      for (const locale of this.$context.flags.locale as string[]) {
        if (platformLocales.includes(locale)) {
          locales.push(locale);
        } else {
          throw new JovoCliError(
            `Could not find platform models for locale: ${printHighlight(locale)}`,
            this.$plugin.constructor.name,
            `Available locales include: ${platformLocales.join(', ')}`,
          );
        }
      }
    }

    // If Jovo model files for the current locales exist, ask whether to back them up or not.
    if (jovo.$project!.hasModelFiles(locales) && !this.$context.flags.force) {
      const answer = await promptOverwriteReverseBuild();
      if (answer.overwrite === ANSWER_CANCEL) {
        return;
      }
      if (answer.overwrite === ANSWER_BACKUP) {
        // Backup old files.
        const backupTask: Task = new Task('Creating backups');
        for (const locale of locales) {
          const localeTask: Task = new Task(locale, () => jovo.$project!.backupModel(locale));
          backupTask.add(localeTask);
        }
        await backupTask.run();
      }
    }
    const reverseTask: Task = new Task('Reversing model files');
    for (const locale of locales) {
      const localeTask: Task = new Task(locale, async () => {
        const alexaModelFiles: NativeFileInformation[] = [
          {
            path: [],
            content: this.getPlatformModel(locale),
          },
        ];
        const jovoModel = new JovoModelAlexa();
        jovoModel.importNative(alexaModelFiles, locale);
        // Apply the changes to the current model-file if one exists
        let modelFile: JovoModelData;
        try {
          modelFile = jovo.$project!.getModel(locale);
        } catch (error) {
          // Currently no model file exists so there is
          // nothing to merge it with.
          modelFile = {
            invocation: '',
          };
        }
        const nativeData: JovoModelData | undefined = jovoModel.exportJovoModel();
        if (!nativeData) {
          throw new JovoCliError(
            'Alexa files did not contain any valid data.',
            this.$plugin.constructor.name,
          );
        }
        _merge(modelFile, nativeData);
        jovo.$project!.saveModel(modelFile, locale);
        await wait(500);
      });
      reverseTask.add(localeTask);
    }
    await reverseTask.run();
  }

  /**
   * Builds the Alexa skill manifest.
   */
  createAlexaProjectFiles() {
    const jovo: JovoCli = JovoCli.getInstance();
    const files: FileObject = FileBuilder.normalizeFileObject(_get(this.$config, 'files', {}));

    // If platforms folder doesn't exist, take default files and parse them with project.js config into FileBuilder.
    const projectFiles: FileObject = jovo.$project!.hasPlatform(getPlatformDirectory())
      ? files
      : _merge(DefaultFiles, files);

    // Merge global project.js properties with platform files.
    const endpoint: string = this.getPluginEndpoint();
    const endpointPath: string = 'skill-package/["skill.json"].manifest.apis.custom.endpoint';
    // If a global endpoint is given and one is not already specified, set the global one.
    if (endpoint && !_has(projectFiles, endpointPath)) {
      // If endpoint is of type ARN, omit the Wildcard certificate.
      const certificate: string | null = !endpoint.startsWith('arn') ? 'Wildcard' : null;
      // Create basic HTTPS endpoint from Wildcard SSL.
      _set(projectFiles, endpointPath, {
        sslCertificateType: certificate,
        uri: endpoint,
      });
    }

    const skillId = _get(this.$config, 'options.skillId');
    const skillIdPath: string = '[".ask/"]["ask-states.json"].profiles.default.skillId';
    // Check whether skill id has already been set.
    if (skillId && !_has(projectFiles, skillIdPath)) {
      _set(projectFiles, skillIdPath, skillId);
    }

    const skillName: string = jovo.$project!.getProjectName();
    const locales: string[] = this.$context.locales.reduce((locales: string[], locale: string) => {
      locales.push(...this.getResolvedLocales(locale));
      return locales;
    }, []);

    for (const locale of locales) {
      // Check whether publishing information has already been set.
      const publishingInformationPath: string = `skill-package/["skill.json"].manifest.publishingInformation.locales.${locale}`;
      if (!_has(projectFiles, publishingInformationPath)) {
        _set(projectFiles, publishingInformationPath, {
          summary: 'Sample Short Description',
          examplePhrases: ['Alexa open hello world'],
          keywords: ['hello', 'world'],
          name: skillName,
          description: 'Sample Full Description',
          smallIconUri: 'https://via.placeholder.com/108/09f/09f.png',
          largeIconUri: 'https://via.placeholder.com/512/09f/09f.png',
        });
      }

      const privacyAndCompliancePath: string = `skill-package/["skill.json"].manifest.privacyAndCompliance.locales.${locale}`;
      // Check whether privacy and compliance information has already been set.
      if (!_has(projectFiles, privacyAndCompliancePath)) {
        _set(projectFiles, privacyAndCompliancePath, {
          privacyPolicyUrl: 'http://example.com/policy',
          termsOfUseUrl: '',
        });
      }
    }

    FileBuilder.buildDirectory(projectFiles, getPlatformPath());
  }

  /**
   * Creates and returns tasks for each locale to build the interaction model for Alexa.
   */
  createInteractionModel(): Task[] {
    const tasks: Task[] = [];

    for (const modelLocale of this.$context.locales) {
      const resolvedLocales: string[] = this.getResolvedLocales(modelLocale);

      const localeTask: Task = new Task(
        `${modelLocale} (${resolvedLocales.join(',')})`,
        async () => {
          this.buildLanguageModel(modelLocale, resolvedLocales);
          await wait(500);
        },
      );

      tasks.push(localeTask);
    }

    return tasks;
  }

  /**
   * Builds and saves Alexa Skill model from Jovo model.
   * @param {string} locale
   * @param {string} stage
   */
  /**
   * Builds and saves Alexa Skill model from Jovo model.
   * @param modelLocale - Locale from Jovo model.
   * @param resolvedLocales - Locales to which the model locale resolves.
   */
  buildLanguageModel(modelLocale: string, resolvedLocales: string[]) {
    const model = this.getJovoModel(modelLocale);

    try {
      for (const locale of resolvedLocales) {
        const jovoModel: JovoModelAlexa = new JovoModelAlexa(model, locale);
        const alexaModelFiles: NativeFileInformation[] = jovoModel.exportNative() as NativeFileInformation[];

        if (!alexaModelFiles || !alexaModelFiles.length) {
          // Should actually never happen but who knows
          throw new JovoCliError(
            `Could not build Alexa files for locale "${locale}"!`,
            this.$plugin.constructor.name,
          );
        }

        const modelsPath: string = getModelsPath();
        if (!existsSync(modelsPath)) {
          mkdirSync(modelsPath, { recursive: true });
        }

        writeFileSync(getModelPath(locale), JSON.stringify(alexaModelFiles[0].content, null, 2));
      }
    } catch (error) {
      if (error instanceof JovoCliError) {
        throw error;
      }
      throw new JovoCliError(error.message, this.$plugin.constructor.name);
    }
  }

  /**
   * Get plugin-specific endpoint.
   */
  getPluginEndpoint(): string {
    const jovo: JovoCli = JovoCli.getInstance();
    const endpoint =
      _get(this.$config, 'options.endpoint') || jovo.$project!.$config.getParameter('endpoint');
    return jovo.resolveEndpoint(endpoint);
  }

  /**
   * Loads a platform-specific model from .
   * @param locale - Locale of the model.
   */
  getPlatformModel(locale: string): JovoModelAlexaData {
    const content: string = readFileSync(getModelPath(locale), 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Returns all locales for the current platform.
   */
  getPlatformLocales(): string[] {
    const files: string[] = readdirSync(getModelsPath());
    // Map each file to it's identifier, without file extension.
    return files.map((file: string) => {
      const localeRegex: RegExp = /(.*)\.(?:[^.]+)$/;
      const match = localeRegex.exec(file);

      // ToDo: Test!
      if (!match) {
        return file;
      }

      return match[1];
    });
  }

  /**
   * Loads a Jovo model specified by a locale and merges it with plugin-specific models.
   * @param locale - The locale that specifies which model to load.
   */
  getJovoModel(locale: string): JovoModelData {
    const jovo: JovoCli = JovoCli.getInstance();
    const model: JovoModelData = jovo.$project!.getModel(locale);

    // Merge model with configured language model in project.js.
    _mergeWith(
      model,
      jovo.$project!.$config.getParameter(`languageModel.${locale}`) || {},
      mergeArrayCustomizer,
    );
    // Merge model with configured, platform-specific language model in project.js.
    _mergeWith(
      model,
      _get(this.$config, `options.languageModel.${locale}`, {}),
      mergeArrayCustomizer,
    );

    return model;
  }
}
