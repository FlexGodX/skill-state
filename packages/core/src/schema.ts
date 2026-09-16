import { isForbiddenKey, isJsonObject, isJsonValue } from "./json.js";
import type { JsonObject, JsonValue, RequestEnvelope } from "./types.js";

export interface JsonSchema {
  $schema?: string;
  title?: string;
  type?: "null" | "boolean" | "number" | "integer" | "string" | "array" | "object";
  anyOf?: JsonSchema[];
  enum?: JsonValue[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

export interface SchemaIssue {
  path: string;
  message: string;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaIssue[];
}

export const jsonValueSchema: JsonSchema = {};
jsonValueSchema.anyOf = [
  { type: "null" },
  { type: "boolean" },
  { type: "number" },
  { type: "string" },
  { type: "array", items: jsonValueSchema },
  { type: "object", additionalProperties: jsonValueSchema },
];

export const requestEnvelopeSchema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "SKILL.state request envelope",
  type: "object",
  required: ["p", "sigma", "o"],
  properties: {
    p: jsonValueSchema,
    sigma: { type: "object", additionalProperties: jsonValueSchema },
    o: { type: "object", additionalProperties: jsonValueSchema },
  },
  additionalProperties: false,
};

export const stateSchema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "SKILL.state session state",
  type: "object",
  additionalProperties: jsonValueSchema,
};

export function validateJsonSchema(value: unknown, schema: JsonSchema): SchemaValidationResult {
  const errors: SchemaIssue[] = [];
  visitSchema(value, schema, "$", errors);
  return { valid: errors.length === 0, errors };
}

export function validateRequestEnvelope(value: unknown): SchemaValidationResult {
  const result = validateJsonSchema(value, requestEnvelopeSchema);
  if (result.valid && hasForbiddenKey(value)) {
    result.valid = false;
    result.errors.push({
      path: "$",
      message: "object contains a forbidden key",
    });
  }
  return result;
}

export function validateState(value: unknown): SchemaValidationResult {
  const result = validateJsonSchema(value, stateSchema);
  if (result.valid && hasForbiddenKey(value)) {
    result.valid = false;
    result.errors.push({
      path: "$",
      message: "object contains a forbidden key",
    });
  }
  return result;
}

export function hasForbiddenKey(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => hasForbiddenKey(item, seen));
  }
  if (!isJsonObject(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, item]) => isForbiddenKey(key) || hasForbiddenKey(item, seen),
  );
}

export function asRequestEnvelope(value: unknown): RequestEnvelope {
  return value as RequestEnvelope;
}

function visitSchema(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: SchemaIssue[],
): void {
  if (schema.anyOf) {
    const branchErrors: SchemaIssue[][] = [];
    for (const branch of schema.anyOf) {
      const candidate: SchemaIssue[] = [];
      visitSchema(value, branch, path, candidate);
      if (candidate.length === 0) {
        return;
      }
      branchErrors.push(candidate);
    }
    errors.push({ path, message: "value does not match any allowed schema" });
    return;
  }

  if (schema.enum && !schema.enum.some((candidate) => sameJsonValue(candidate, value))) {
    errors.push({ path, message: "value is not one of the allowed values" });
    return;
  }

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push({ path, message: `expected ${schema.type}` });
    return;
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `string length is less than ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `string length exceeds ${schema.maxLength}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `array length is less than ${schema.minItems}` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `array length exceeds ${schema.maxItems}` });
    }
    if (schema.items) {
      value.forEach((item, index) => visitSchema(item, schema.items as JsonSchema, `${path}[${index}]`, errors));
    }
  }

  if (isJsonObject(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        errors.push({ path, message: `missing required property ${required}` });
      }
    }

    for (const [key, item] of Object.entries(value)) {
      const childSchema = schema.properties?.[key];
      if (childSchema) {
        visitSchema(item, childSchema, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: `${path}.${key}`, message: "additional properties are not allowed" });
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        visitSchema(item, schema.additionalProperties, `${path}.${key}`, errors);
      }
    }
  }
}

function matchesType(
  value: unknown,
  type: NonNullable<JsonSchema["type"]>,
): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    case "object":
      return isJsonObject(value);
  }
}

function sameJsonValue(left: JsonValue, right: unknown): boolean {
  if (!isJsonValue(right)) {
    return false;
  }
  if (left === right) {
    return true;
  }
  if (typeof left !== typeof right || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameJsonValue(item, right[index]));
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
      && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
        && sameJsonValue(left[key] as JsonValue, right[key]));
  }
  return false;
}
