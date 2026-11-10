// S12: put values into a response that the SDK was generated without knowing about, wherever the contract says more may
// appear later: x-rask-open-enum, x-rask-open-union, and any object that does not close its properties.

export const UNKNOWN_ENUM_VALUE = 's12_unknown_enum_value';
export const UNKNOWN_VARIANT = 's12_unknown_variant';
export const UNKNOWN_FIELD = 's12_unknown_field';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

class Injector {
  constructor(contract, kinds) {
    this.contract = contract;
    this.kinds = kinds;
    this.injections = [];
    this.reached = new Set();
    this.inMaterialized = false;
  }

  note(kind, pointer, value) {
    this.injections.push({ kind, pointer: pointer || '/', value });
    return value;
  }

  unknownVariant(discriminator, pointer) {
    return this.note('union', pointer, { [discriminator]: UNKNOWN_VARIANT, [UNKNOWN_FIELD]: 'unknown variant payload' });
  }

  // A null is a place too: Job.cost and Job.stage are null in many examples, but they hold open types when set.
  fillNull(schema, pointer) {
    for (const branch of schema.anyOf ?? []) {
      const target = this.contract.deref(branch);
      this.mark(branch);
      if (this.kinds.union && target['x-rask-open-union']) {
        return this.unknownVariant(target.discriminator.propertyName, pointer);
      }
      if (this.kinds.enum && target['x-rask-open-enum']) return this.note('enum', pointer, UNKNOWN_ENUM_VALUE);
    }
    if (this.kinds.enum && schema['x-rask-open-enum']) return this.note('enum', pointer, UNKNOWN_ENUM_VALUE);
    return null;
  }

  mark(rawSchema) {
    if (rawSchema.$ref) this.reached.add(rawSchema.$ref.split('/').at(-1));
  }

  // Open enums behind a null or an empty list never show in an example (ProcessingFailureCode, JobNoticeCode), so fill
  // those from the schema and inject there too. Once, not recursively: what the builder made is already complete.
  materialize(schema, value, pointer) {
    if (this.inMaterialized || !this.kinds.enum) return value;
    let target = null;
    let built = null;
    if (value === null) {
      target = (schema.anyOf ?? []).find((branch) => this.contract.deref(branch).type !== 'null') ?? null;
      if (target) built = this.contract.build(target);
    } else if (Array.isArray(value) && value.length === 0 && schema.items) {
      target = schema;
      const item = this.contract.build(schema.items);
      if (item !== undefined) built = [item];
    }
    if (built === null || built === undefined) return value;
    this.inMaterialized = true;
    const result = this.walk(target, built, pointer);
    this.inMaterialized = false;
    return result;
  }

  walk(rawSchema, value, pointer, skipField = null) {
    this.mark(rawSchema);
    const schema = this.contract.deref(rawSchema);
    if (value === null) {
      const filled = this.fillNull(schema, pointer);
      return filled === null ? this.materialize(schema, value, pointer) : filled;
    }
    if (schema.anyOf) {
      const branch = schema.anyOf.find((candidate) => this.contract.deref(candidate).type !== 'null');
      return branch ? this.walk(branch, value, pointer) : value;
    }
    if (schema.discriminator) {
      const { propertyName, mapping } = schema.discriminator;
      if (this.kinds.union && schema['x-rask-open-union']) return this.unknownVariant(propertyName, pointer);
      const target = mapping[value[propertyName]];
      return target ? this.walk({ $ref: target }, value, pointer, propertyName) : value;
    }
    if (Array.isArray(value)) {
      if (!schema.items) return value;
      if (value.length === 0) return this.materialize(schema, value, pointer);
      return value.map((item, index) => this.walk(schema.items, item, `${pointer}/${index}`));
    }
    if (typeof value === 'string' && this.kinds.enum && schema['x-rask-open-enum']) {
      return this.note('enum', pointer, UNKNOWN_ENUM_VALUE);
    }
    if (!isObject(value) || !schema.properties) return value;
    const result = {};
    for (const [name, child] of Object.entries(value)) {
      const property = schema.properties[name];
      // A discriminator's new values are what the union kind injects: an unknown variant.
      if (property && name === skipField) this.mark(property);
      result[name] = property && name !== skipField ? this.walk(property, child, `${pointer}/${name}`) : child;
    }
    if (this.kinds.field && schema.additionalProperties !== false) {
      result[UNKNOWN_FIELD] = this.note('field', `${pointer}/${UNKNOWN_FIELD}`, 'unknown field value');
    }
    return result;
  }
}

export function normalizeKinds(inject) {
  if (inject === true) return { enum: true, union: true, field: true };
  return { enum: Boolean(inject.enum), union: Boolean(inject.union), field: Boolean(inject.field) };
}

export function injectUnknowns(contract, schema, body, inject) {
  const injector = new Injector(contract, normalizeKinds(inject));
  const result = injector.walk(schema, body, '');
  return { body: result, injections: injector.injections, reached: injector.reached };
}
