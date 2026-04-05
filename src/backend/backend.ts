// Ported from code-debug (os-debug) src/backend/backend.ts
// Removed SSH, IBackend (not needed), kept VariableObject, MIError, and type definitions.

import { MINode } from "./mi_parse";
import { DebugProtocol } from "@vscode/debugprotocol";

export type ValuesFormattingMode = "disabled" | "parseText" | "prettyPrinters";

export interface Breakpoint {
	id?: number;
	file?: string;
	line?: number;
	raw?: string;
	condition: string;
	countCondition?: string;
	logMessage?: string;
}

export interface Thread {
	id: number;
	targetId: string;
	name?: string;
}

export interface Stack {
	level: number;
	address: string;
	function: string;
	fileName: string;
	file: string;
	line: number;
}

export interface Variable {
	name: string;
	valueStr: string;
	type: string;
	raw?: any;
}

export interface RegisterValue {
	index: number;
	value: string;
}

export interface Register {
	name: string;
	valueStr: string;
}

export class VariableObject {
	name: string;
	exp: string;
	numchild: number;
	type: string;
	value: string;
	threadId: string;
	frozen: boolean;
	dynamic: boolean;
	displayhint: string;
	hasMore: boolean;
	id: number = 0;
	constructor(node: any) {
		this.name = MINode.valueOf(node, "name");
		this.exp = MINode.valueOf(node, "exp");
		this.numchild = parseInt(MINode.valueOf(node, "numchild"));
		this.type = MINode.valueOf(node, "type");
		this.value = MINode.valueOf(node, "value");
		this.threadId = MINode.valueOf(node, "thread-id");
		this.frozen = !!MINode.valueOf(node, "frozen");
		this.dynamic = !!MINode.valueOf(node, "dynamic");
		this.displayhint = MINode.valueOf(node, "displayhint");
		this.hasMore = !!MINode.valueOf(node, "has_more");
	}

	public applyChanges(node: MINode) {
		this.value = MINode.valueOf(node, "value");
		if (MINode.valueOf(node, "type_changed")) {
			this.type = MINode.valueOf(node, "new_type");
		}
		this.dynamic = !!MINode.valueOf(node, "dynamic");
		this.displayhint = MINode.valueOf(node, "displayhint");
		this.hasMore = !!MINode.valueOf(node, "has_more");
	}

	public isCompound(): boolean {
		return (
			this.numchild > 0 ||
			this.value === "{...}" ||
			(this.dynamic && (this.displayhint === "array" || this.displayhint === "map"))
		);
	}

	public toProtocolVariable(): DebugProtocol.Variable {
		const res: DebugProtocol.Variable = {
			name: this.exp,
			evaluateName: this.name,
			value: this.value === void 0 ? "<unknown>" : this.value,
			type: this.type,
			variablesReference: this.id,
		};
		return res;
	}
}

// from https://gist.github.com/justmoon/15511f92e5216fa2624b#gistcomment-1928632
export interface MIError extends Error {
	readonly name: string;
	readonly message: string;
	readonly source: string;
}
export interface MIErrorConstructor {
	new(message: string, source: string): MIError;
	readonly prototype: MIError;
}

export const MIError: MIErrorConstructor = class MIError {
	private readonly _message: string;
	private readonly _source: string;
	public constructor(message: string, source: string) {
		this._message = message;
		this._source = source;
		Error.captureStackTrace(this, this.constructor);
	}

	get name() { return this.constructor.name; }
	get message() { return this._message; }
	get source() { return this._source; }

	public toString() {
		return `${this.message} (from ${this._source})`;
	}
};
Object.setPrototypeOf(MIError as any, Object.create(Error.prototype));
MIError.prototype.constructor = MIError;
