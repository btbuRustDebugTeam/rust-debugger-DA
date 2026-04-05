"use strict";
// Ported from code-debug (os-debug) src/backend/backend.ts
// Removed SSH, IBackend (not needed), kept VariableObject, MIError, and type definitions.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIError = exports.VariableObject = void 0;
const mi_parse_1 = require("./mi_parse");
class VariableObject {
    constructor(node) {
        this.id = 0;
        this.name = mi_parse_1.MINode.valueOf(node, "name");
        this.exp = mi_parse_1.MINode.valueOf(node, "exp");
        this.numchild = parseInt(mi_parse_1.MINode.valueOf(node, "numchild"));
        this.type = mi_parse_1.MINode.valueOf(node, "type");
        this.value = mi_parse_1.MINode.valueOf(node, "value");
        this.threadId = mi_parse_1.MINode.valueOf(node, "thread-id");
        this.frozen = !!mi_parse_1.MINode.valueOf(node, "frozen");
        this.dynamic = !!mi_parse_1.MINode.valueOf(node, "dynamic");
        this.displayhint = mi_parse_1.MINode.valueOf(node, "displayhint");
        this.hasMore = !!mi_parse_1.MINode.valueOf(node, "has_more");
    }
    applyChanges(node) {
        this.value = mi_parse_1.MINode.valueOf(node, "value");
        if (mi_parse_1.MINode.valueOf(node, "type_changed")) {
            this.type = mi_parse_1.MINode.valueOf(node, "new_type");
        }
        this.dynamic = !!mi_parse_1.MINode.valueOf(node, "dynamic");
        this.displayhint = mi_parse_1.MINode.valueOf(node, "displayhint");
        this.hasMore = !!mi_parse_1.MINode.valueOf(node, "has_more");
    }
    isCompound() {
        return (this.numchild > 0 ||
            this.value === "{...}" ||
            (this.dynamic && (this.displayhint === "array" || this.displayhint === "map")));
    }
    toProtocolVariable() {
        const res = {
            name: this.exp,
            evaluateName: this.name,
            value: this.value === void 0 ? "<unknown>" : this.value,
            type: this.type,
            variablesReference: this.id,
        };
        return res;
    }
}
exports.VariableObject = VariableObject;
const MIError = class MIError {
    constructor(message, source) {
        this._message = message;
        this._source = source;
        Error.captureStackTrace(this, this.constructor);
    }
    get name() { return this.constructor.name; }
    get message() { return this._message; }
    get source() { return this._source; }
    toString() {
        return `${this.message} (from ${this._source})`;
    }
};
exports.MIError = MIError;
Object.setPrototypeOf(exports.MIError, Object.create(Error.prototype));
exports.MIError.prototype.constructor = exports.MIError;
//# sourceMappingURL=backend.js.map