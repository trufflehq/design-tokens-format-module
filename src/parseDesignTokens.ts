import dlv from 'dlv';

import {
  DesignTokenGroup,
  DesignTokenTree,
  DesignTokenType,
  DesignToken,
  DesignTokenValue,
} from './types/designTokenFormatModule.js';
import { ConcreteDesignTokenTree } from './types/concreteDesignTokenTree.js';
import { matchIsAlias } from './utils/matchIsAlias.js';
import { validateDesignTokenValue } from './utils/validateDesignTokenValue.js';
import { validateDesignTokenAndGroupName } from './utils/validateDesignTokenAndGroupName.js';
import { inferJSONValueType } from './utils/inferJSONValueType.js';

export function resolveAlias(
  rawAlias: string,
  options?: ParseDesignTokensOptions,
  context?: DesignTokenTree
) {
  // rawAlias is like {colors.primary}
  const alias = rawAlias.slice(1, -1);
  const finalContext = context || {};
  const currentPath = alias.split('.');
  const foundEntry = dlv(finalContext, alias) as DesignTokenTree;
  if (foundEntry) {
    if (!options?.resolveAliases) {
      return rawAlias;
    }
    const tokenName = alias.split('.').pop() as string;
    const parentPath = alias.split('.').slice(0, -1).join('.');
    const maybeParent =
      parentPath.length > 0
        ? (dlv(finalContext, parentPath) as DesignTokenTree)
        : undefined;

    const result = parseDesignTokens(
      { [tokenName]: foundEntry },
      options,
      maybeParent,
      context,
      currentPath
    ) as DesignTokenTree;
    const formatted = Object.values(result)[0];

    if (options.flattenAliases && '$value' in formatted) {
      return formatted.$value;
    }

    return {
      ...formatted,
      ...(options?.publishMetadata
        ? {
            _kind: 'alias' as const,
            _name: tokenName,
            _path: currentPath,
          }
        : {}),
    };
  } else if (options?.skipValidation) {
    return rawAlias;
  } else {
    throw new Error(
      `Alias "${alias}" not found in context: ${JSON.stringify(
        context,
        null,
        2
      )}`
    );
  }
}

function resolveObjectValue(
  value: Omit<DesignTokenValue, string | symbol | number>,
  options?: ParseDesignTokensOptions,
  parent?: DesignTokenTree,
  context?: DesignTokenTree,
  path: Array<string> = []
): { [key: string]: DesignTokenValue } {
  return Object.entries(value).reduce((acc, [key, value]) => {
    const currentPath = path.concat(key);
    if (matchIsAlias(value)) {
      return {
        ...acc,
        [key]: resolveAlias(value as string, options, context),
      };
    } else if (Array.isArray(value)) {
      return {
        ...acc,
        [key]: resolveArrayValue(value, options, parent, context, currentPath),
      };
    } else if (value !== null && typeof value === 'object') {
      return {
        ...acc,
        [key]: resolveObjectValue(value, options, parent, context, currentPath),
      };
    } else {
      return {
        ...acc,
        [key]: value,
      };
    }
  }, {});
}

function resolveArrayValue(
  value: DesignTokenValue[],
  options?: ParseDesignTokensOptions,
  parent?: DesignTokenTree,
  context?: DesignTokenTree,
  path: Array<string> = []
): DesignTokenValue[] {
  return value.map((item, i) => {
    const currentPath = path.concat(`[${i}]`);
    if (matchIsAlias(item)) {
      return resolveAlias(item as string, options, context);
    } else if (Array.isArray(item)) {
      return resolveArrayValue(item, options, parent, context, currentPath);
    } else if (item !== null && typeof item === 'object') {
      return resolveObjectValue(item, options, parent, context, currentPath);
    }

    return item;
  });
}

export type ParseDesignTokensOptions<
  RA extends boolean = boolean,
  PM extends boolean = boolean,
  FA extends boolean = boolean,
  SV extends boolean = boolean
> = {
  resolveAliases?: RA;
  publishMetadata?: PM;
  flattenAliases?: FA;
  skipValidation?: SV;
};

export function parseDesignTokens<
  RA extends boolean = false,
  PM extends boolean = false,
  FA extends boolean = false,
  SV extends boolean = false
>(
  tokens: DesignTokenTree,
  options?: ParseDesignTokensOptions<RA, PM, FA>,
  parent?: DesignTokenTree,
  context?: DesignTokenTree,
  path: Array<string> = []
): ConcreteDesignTokenTree<RA, PM> {
  if (!context) {
    context = tokens;
  }

  return Object.entries(tokens).reduce((acc, [name, value]) => {
    // const { $type, $description, $value, $extensions, ...rest } = value
    validateDesignTokenAndGroupName(name);
    const currentPath = path.concat(name);

    let maybeType: DesignTokenType | undefined;
    if (value.$type) {
      maybeType = value.$type as DesignTokenType;
    } else if (parent && parent.$type) {
      // From direct parent if exists
      maybeType = parent.$type as DesignTokenType;
    }

    // A Token has a $value
    if ('$value' in value && value.$value !== undefined) {
      const { $description, $value, $extensions } = value as DesignToken;
      const isAlias = matchIsAlias($value);

      let finalValue: DesignTokenValue = $value;
      if (isAlias) {
        finalValue = resolveAlias($value as string, options, context);
      } else if (Array.isArray($value)) {
        finalValue = resolveArrayValue(
          $value,
          options,
          parent,
          context,
          currentPath
        );
      } else if ($value !== null && typeof $value === 'object') {
        finalValue = resolveObjectValue(
          $value,
          options,
          parent,
          context,
          currentPath
        );
      }

      if (
        isAlias &&
        finalValue !== null &&
        typeof finalValue === 'object' &&
        '$type' in finalValue
      ) {
        if (maybeType === undefined) {
          maybeType = finalValue.$type as DesignTokenType;
        } else if (maybeType !== finalValue.$type) {
          throw new Error(
            `Type mismatch: ${maybeType} !== ${
              finalValue.$type
            } at path "${currentPath.join('.')}"`
          );
        }
      }

      // We expect the process to have resolved the token $type at this stage
      if (maybeType === undefined) {
        maybeType = inferJSONValueType($value);
      }
      
      if (!options?.skipValidation) {
        validateDesignTokenValue(maybeType, $value);
      }

      return {
        ...acc,
        [name]: {
          $type: maybeType,
          $value: finalValue,
          ...($description ? { $description } : {}),
          ...($extensions ? { $extensions } : {}),
          ...(options?.publishMetadata
            ? {
                _kind: 'token' as const,
                _path: currentPath,
              }
            : {}),
        },
      };
    } else {
      // A Group has NOT a $value
      const { $description } = value as DesignTokenGroup;

      const merged = Object.entries(value)
        .filter(
          ([k, v]) =>
            !k.startsWith('$') &&
            v !== null &&
            typeof v === 'object' &&
            !Array.isArray(v)
        )
        .reduce(
          (acc, [k, v]) => ({
            ...acc,
            ...parseDesignTokens(
              { [k]: v } as DesignTokenTree,
              options,
              value as DesignTokenTree,
              context,
              currentPath
            ),
          }),
          {}
        ) as DesignTokenTree;
      return {
        ...acc,
        [name]: {
          ...(maybeType ? { $type: maybeType } : {}),
          ...($description ? { $description } : {}),
          ...(options?.publishMetadata
            ? {
                _kind: 'group' as const,
                _path: currentPath,
              }
            : {}),
          ...merged,
        },
      };
    }
  }, {});
}
