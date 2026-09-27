const OPTIONAL_SCHEMA = Symbol("pi-agent-browser-optional-schema");
function withOptions(schema, options) {
    return { ...schema, ...(options ?? {}) };
}
function literalType(value) {
    const valueType = typeof value;
    return valueType === "string" || valueType === "number" || valueType === "boolean" ? valueType : undefined;
}
function propertySchema(schema) {
    const clone = { ...schema };
    delete clone[OPTIONAL_SCHEMA];
    return clone;
}
export const JsonSchema = {
    Array(items, options) {
        return withOptions({ type: "array", items }, options);
    },
    Boolean(options) {
        return withOptions({ type: "boolean" }, options);
    },
    Integer(options) {
        return withOptions({ type: "integer" }, options);
    },
    Literal(value, options) {
        const type = literalType(value);
        return withOptions(type ? { type, const: value } : { const: value }, options);
    },
    Number(options) {
        return withOptions({ type: "number" }, options);
    },
    Object(properties, options) {
        const required = globalThis.Object.entries(properties)
            .filter(([, schema]) => schema[OPTIONAL_SCHEMA] !== true)
            .map(([key]) => key);
        return withOptions({
            type: "object",
            properties: globalThis.Object.fromEntries(globalThis.Object.entries(properties).map(([key, schema]) => [key, propertySchema(schema)])),
            ...(required.length > 0 ? { required } : {}),
        }, options);
    },
    Optional(schema) {
        return { ...schema, [OPTIONAL_SCHEMA]: true };
    },
    String(options) {
        return withOptions({ type: "string" }, options);
    },
    Union(types, options) {
        return withOptions({ anyOf: types }, options);
    },
    Unsafe(schema) {
        return schema;
    },
};
