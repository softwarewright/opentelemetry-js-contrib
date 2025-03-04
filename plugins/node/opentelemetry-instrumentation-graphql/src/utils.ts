/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type * as graphqlTypes from 'graphql';
import * as api from '@opentelemetry/api';
import { AllowedOperationTypes, SpanNames, TokenKind } from './enum';
import { AttributeNames } from './enums/AttributeNames';
import { OTEL_GRAPHQL_DATA_SYMBOL, OTEL_PATCHED_SYMBOL } from './symbols';
import {
  GraphQLField,
  GraphQLPath,
  GraphQLInstrumentationParsedConfig,
  ObjectWithGraphQLData,
  OtelPatched,
  Maybe,
} from './internal-types';
import { GraphQLInstrumentationConfig } from './types';

const OPERATION_VALUES = Object.values(AllowedOperationTypes);

// https://github.com/graphql/graphql-js/blob/main/src/jsutils/isPromise.ts
export const isPromise = (value: any): value is Promise<unknown> => {
  return typeof value?.then === 'function';
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addInputVariableAttribute(span: api.Span, key: string, variable: any) {
  if (Array.isArray(variable)) {
    variable.forEach((value, idx) => {
      addInputVariableAttribute(span, `${key}.${idx}`, value);
    });
  } else if (variable instanceof Object) {
    Object.entries(variable).forEach(([nestedKey, value]) => {
      addInputVariableAttribute(span, `${key}.${nestedKey}`, value);
    });
  } else {
    span.setAttribute(`${AttributeNames.VARIABLES}${String(key)}`, variable);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function addInputVariableAttributes(
  span: api.Span,
  variableValues: { [key: string]: any }
) {
  Object.entries(variableValues).forEach(([key, value]) => {
    addInputVariableAttribute(span, key, value);
  });
}

export function addSpanSource(
  span: api.Span,
  loc?: graphqlTypes.Location,
  allowValues?: boolean,
  start?: number,
  end?: number
): void {
  const source = getSourceFromLocation(loc, allowValues, start, end);
  span.setAttribute(AttributeNames.SOURCE, source);
}

function createFieldIfNotExists(
  tracer: api.Tracer,
  getConfig: () => GraphQLInstrumentationParsedConfig,
  contextValue: any,
  info: graphqlTypes.GraphQLResolveInfo,
  path: string[]
): {
  field: any;
  spanAdded: boolean;
} {
  let field = getField(contextValue, path);

  let spanAdded = false;

  if (!field) {
    spanAdded = true;
    const parent = getParentField(contextValue, path);

    field = {
      parent,
      span: createResolverSpan(
        tracer,
        getConfig,
        contextValue,
        info,
        path,
        parent.span
      ),
      error: null,
    };

    addField(contextValue, path, field);
  }

  return { spanAdded, field };
}

function createResolverSpan(
  tracer: api.Tracer,
  getConfig: () => GraphQLInstrumentationParsedConfig,
  contextValue: any,
  info: graphqlTypes.GraphQLResolveInfo,
  path: string[],
  parentSpan?: api.Span
): api.Span {
  const attributes: api.SpanAttributes = {
    [AttributeNames.FIELD_NAME]: info.fieldName,
    [AttributeNames.FIELD_PATH]: path.join('.'),
    [AttributeNames.FIELD_TYPE]: info.returnType.toString(),
  };

  const span = tracer.startSpan(
    SpanNames.RESOLVE,
    {
      attributes,
    },
    parentSpan ? api.trace.setSpan(api.context.active(), parentSpan) : undefined
  );

  const document = contextValue[OTEL_GRAPHQL_DATA_SYMBOL].source;
  const fieldNode = info.fieldNodes.find(
    fieldNode => fieldNode.kind === 'Field'
  );

  if (fieldNode) {
    addSpanSource(
      span,
      document.loc,
      getConfig().allowValues,
      fieldNode.loc?.start,
      fieldNode.loc?.end
    );
  }

  return span;
}

export function endSpan(span: api.Span, error?: Error): void {
  if (error) {
    span.recordException(error);
  }
  span.end();
}

export function getOperation(
  document: graphqlTypes.DocumentNode,
  operationName?: Maybe<string>
): graphqlTypes.DefinitionNode | undefined {
  if (!document || !Array.isArray(document.definitions)) {
    return undefined;
  }

  if (operationName) {
    return document.definitions
      .filter(
        definition =>
          OPERATION_VALUES.indexOf((definition as any)?.operation) !== -1
      )
      .find(definition => operationName === (definition as any)?.name?.value);
  } else {
    return document.definitions.find(
      definition =>
        OPERATION_VALUES.indexOf((definition as any)?.operation) !== -1
    );
  }
}

function addField(contextValue: any, path: string[], field: GraphQLField) {
  return (contextValue[OTEL_GRAPHQL_DATA_SYMBOL].fields[path.join('.')] =
    field);
}

function getField(contextValue: any, path: string[]) {
  return contextValue[OTEL_GRAPHQL_DATA_SYMBOL].fields[path.join('.')];
}

function getParentField(contextValue: any, path: string[]) {
  for (let i = path.length - 1; i > 0; i--) {
    const field = getField(contextValue, path.slice(0, i));

    if (field) {
      return field;
    }
  }

  return {
    span: contextValue[OTEL_GRAPHQL_DATA_SYMBOL].span,
  };
}

function pathToArray(mergeItems: boolean, path: GraphQLPath): string[] {
  const flattened: string[] = [];
  let curr: GraphQLPath | undefined = path;
  while (curr) {
    let key = curr.key;

    if (mergeItems && typeof key === 'number') {
      key = '*';
    }
    flattened.push(String(key));
    curr = curr.prev;
  }
  return flattened.reverse();
}

function repeatBreak(i: number): string {
  return repeatChar('\n', i);
}

function repeatSpace(i: number): string {
  return repeatChar(' ', i);
}

function repeatChar(char: string, to: number): string {
  let text = '';
  for (let i = 0; i < to; i++) {
    text += char;
  }
  return text;
}

const KindsToBeRemoved: string[] = [
  TokenKind.FLOAT,
  TokenKind.STRING,
  TokenKind.INT,
  TokenKind.BLOCK_STRING,
];

export function getSourceFromLocation(
  loc?: graphqlTypes.Location,
  allowValues = false,
  inputStart?: number,
  inputEnd?: number
): string {
  let source = '';

  if (loc?.startToken) {
    const start = typeof inputStart === 'number' ? inputStart : loc.start;
    const end = typeof inputEnd === 'number' ? inputEnd : loc.end;

    let next: graphqlTypes.Token | null = loc.startToken.next;
    let previousLine: number | undefined = 1;
    while (next) {
      if (next.start < start) {
        next = next.next;
        previousLine = next?.line;
        continue;
      }
      if (next.end > end) {
        next = next.next;
        previousLine = next?.line;
        continue;
      }
      let value = next.value || next.kind;
      let space = '';
      if (!allowValues && KindsToBeRemoved.indexOf(next.kind) >= 0) {
        // value = repeatChar('*', value.length);
        value = '*';
      }
      if (next.kind === TokenKind.STRING) {
        value = `"${value}"`;
      }
      if (next.kind === TokenKind.EOF) {
        value = '';
      }
      if (next.line > previousLine!) {
        source += repeatBreak(next.line - previousLine!);
        previousLine = next.line;
        space = repeatSpace(next.column - 1);
      } else {
        if (next.line === next.prev?.line) {
          space = repeatSpace(next.start - (next.prev?.end || 0));
        }
      }
      source += space + value;
      if (next) {
        next = next.next!;
      }
    }
  }

  return source;
}

export function wrapFields(
  type: Maybe<graphqlTypes.GraphQLObjectType & OtelPatched>,
  tracer: api.Tracer,
  getConfig: () => GraphQLInstrumentationParsedConfig
): void {
  if (
    !type ||
    typeof type.getFields !== 'function' ||
    type[OTEL_PATCHED_SYMBOL]
  ) {
    return;
  }
  const fields = type.getFields();

  type[OTEL_PATCHED_SYMBOL] = true;

  Object.keys(fields).forEach(key => {
    const field = fields[key];

    if (!field) {
      return;
    }

    if (field.resolve) {
      field.resolve = wrapFieldResolver(tracer, getConfig, field.resolve);
    }

    if (field.type) {
      let unwrappedType: any = field.type;

      while (unwrappedType.ofType) {
        unwrappedType = unwrappedType.ofType;
      }
      wrapFields(unwrappedType, tracer, getConfig);
    }
  });
}

const handleResolveSpanError = (
  resolveSpan: api.Span,
  err: any,
  shouldEndSpan: boolean
) => {
  if (!shouldEndSpan) {
    return;
  }
  resolveSpan.recordException(err);
  resolveSpan.setStatus({
    code: api.SpanStatusCode.ERROR,
    message: err.message,
  });
  resolveSpan.end();
};

const handleResolveSpanSuccess = (
  resolveSpan: api.Span,
  shouldEndSpan: boolean
) => {
  if (!shouldEndSpan) {
    return;
  }
  resolveSpan.end();
};

export function wrapFieldResolver<TSource = any, TContext = any, TArgs = any>(
  tracer: api.Tracer,
  getConfig: () => Required<GraphQLInstrumentationConfig>,
  fieldResolver: Maybe<
    graphqlTypes.GraphQLFieldResolver<TSource, TContext, TArgs> & OtelPatched
  >
): graphqlTypes.GraphQLFieldResolver<TSource, TContext, TArgs> & OtelPatched {
  if (
    (wrappedFieldResolver as OtelPatched)[OTEL_PATCHED_SYMBOL] ||
    typeof fieldResolver !== 'function'
  ) {
    return fieldResolver!;
  }

  function wrappedFieldResolver(
    this: graphqlTypes.GraphQLFieldResolver<TSource, TContext, TArgs>,
    source: TSource,
    args: TArgs,
    contextValue: TContext & ObjectWithGraphQLData,
    info: graphqlTypes.GraphQLResolveInfo
  ) {
    if (!fieldResolver) {
      return undefined;
    }
    const config = getConfig();

    if (!contextValue[OTEL_GRAPHQL_DATA_SYMBOL]) {
      return fieldResolver.call(this, source, args, contextValue, info);
    }
    const path = pathToArray(config.mergeItems, info && info.path);
    const depth = path.filter((item: any) => typeof item === 'string').length;

    let field: any;
    let shouldEndSpan = false;
    if (config.depth >= 0 && config.depth < depth) {
      field = getParentField(contextValue, path);
    } else {
      const newField = createFieldIfNotExists(
        tracer,
        getConfig,
        contextValue,
        info,
        path
      );
      field = newField.field;
      shouldEndSpan = newField.spanAdded;
    }

    return api.context.with(
      api.trace.setSpan(api.context.active(), field.span),
      () => {
        try {
          const res = fieldResolver.call(
            this,
            source,
            args,
            contextValue,
            info
          );
          if (isPromise(res)) {
            return res.then(
              (r: any) => {
                handleResolveSpanSuccess(field.span, shouldEndSpan);
                return r;
              },
              (err: Error) => {
                handleResolveSpanError(field.span, err, shouldEndSpan);
                throw err;
              }
            );
          } else {
            handleResolveSpanSuccess(field.span, shouldEndSpan);
            return res;
          }
        } catch (err: any) {
          handleResolveSpanError(field.span, err, shouldEndSpan);
          throw err;
        }
      }
    );
  }

  (wrappedFieldResolver as OtelPatched)[OTEL_PATCHED_SYMBOL] = true;

  return wrappedFieldResolver;
}
