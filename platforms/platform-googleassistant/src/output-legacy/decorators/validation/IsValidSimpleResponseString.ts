import { IsEitherValid, isString, ValidationOptions } from '@jovotech/output';
import { SimpleResponse } from '../../models';

export function IsValidSimpleResponseString(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return IsEitherValid<SimpleResponse>(
    {
      name: 'isValidSimpleResponseString',
      keys: ['textToSpeech', 'ssml'],
      validate: (value: string) => {
        if (!isString(value)) {
          return '$property must be a string';
        }
        if (!value) {
          return '$property should not be empty';
        }
        return;
      },
    },
    validationOptions,
  );
}
