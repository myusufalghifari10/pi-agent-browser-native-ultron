import { JsonSchema } from "./json-schema.js";
export function StringEnum(values, options) {
    return JsonSchema.Unsafe({
        type: "string",
        enum: [...values],
        ...options,
    });
}
