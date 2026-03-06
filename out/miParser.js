"use strict";
/**
 * GDB/MI2 output parser.
 *
 * MI2 output lines fall into several categories:
 *
 *   Result records   – start with an optional token then '^'
 *       Examples:  ^done,threads=[...]    123^error,msg="..."
 *
 *   Async records    – start with an optional token then '*', '+', or '='
 *       *  exec-async  (*stopped, *running)
 *       +  status-async
 *       =  notify-async (=thread-created, =breakpoint-modified, ...)
 *
 *   Stream records   – start with '~', '@', or '&'
 *       ~  console stream (GDB text output)
 *       @  target stream
 *       &  log stream
 *
 *   (gdb)            – prompt, signals MI is ready for next command
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseMILine = parseMILine;
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Parse a single complete MI2 output line into a structured record.
 * Returns `undefined` if the line cannot be recognised.
 */
function parseMILine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
        return undefined;
    }
    // Prompt
    if (trimmed === '(gdb)') {
        return { type: 'prompt', data: {} };
    }
    // Stream records: ~"...", @"...", &"..."
    if (trimmed[0] === '~' || trimmed[0] === '@' || trimmed[0] === '&') {
        const typeMap = {
            '~': 'console-stream',
            '@': 'target-stream',
            '&': 'log-stream',
        };
        const content = parseCString(trimmed.substring(1));
        return {
            type: typeMap[trimmed[0]],
            data: { msg: content },
        };
    }
    // Result / async records: [token]^class,... or [token]*class,...
    // Extract optional leading token (digits)
    let pos = 0;
    let token;
    while (pos < trimmed.length && trimmed[pos] >= '0' && trimmed[pos] <= '9') {
        pos++;
    }
    if (pos > 0) {
        token = parseInt(trimmed.substring(0, pos), 10);
    }
    if (pos >= trimmed.length) {
        return undefined;
    }
    const prefix = trimmed[pos];
    const typeMap = {
        '^': 'result',
        '*': 'exec-async',
        '+': 'status-async',
        '=': 'notify-async',
    };
    const recordType = typeMap[prefix];
    if (!recordType) {
        return undefined;
    }
    const rest = trimmed.substring(pos + 1);
    // Extract class word (everything up to first ',' or end)
    let commaIdx = findTopLevelComma(rest, 0);
    let cls;
    let dataStr;
    if (commaIdx === -1) {
        cls = rest;
        dataStr = '';
    }
    else {
        cls = rest.substring(0, commaIdx);
        dataStr = rest.substring(commaIdx + 1);
    }
    const data = dataStr ? parseMITuple(dataStr) : {};
    return { type: recordType, token, cls, data };
}
// ---------------------------------------------------------------------------
// MI value parser
// ---------------------------------------------------------------------------
/**
 * Parse a top-level MI "tuple-like" key=value,key=value string.
 * Handles nested {} (tuple), [] (list), and "..." (c-string) values.
 */
function parseMITuple(input) {
    const result = {};
    let pos = 0;
    const len = input.length;
    // Strip surrounding braces if present
    if (input[0] === '{' && input[len - 1] === '}') {
        pos = 1;
    }
    while (pos < len) {
        // Skip whitespace and commas
        while (pos < len && (input[pos] === ',' || input[pos] === ' ')) {
            pos++;
        }
        if (pos >= len || input[pos] === '}')
            break;
        // Read key
        const eqIdx = input.indexOf('=', pos);
        if (eqIdx === -1)
            break;
        const key = input.substring(pos, eqIdx).trim();
        pos = eqIdx + 1;
        // Read value
        const [value, newPos] = parseMIValue(input, pos);
        result[key] = value;
        pos = newPos;
    }
    return result;
}
/**
 * Parse a single MI value starting at `pos`.
 * Returns [parsedValue, newPos].
 */
function parseMIValue(input, pos) {
    if (pos >= input.length) {
        return ['', pos];
    }
    const ch = input[pos];
    if (ch === '"') {
        return parseMICString(input, pos);
    }
    if (ch === '{') {
        return parseMITupleValue(input, pos);
    }
    if (ch === '[') {
        return parseMIListValue(input, pos);
    }
    // Bare word / number (shouldn't happen in well-formed MI, but handle gracefully)
    let end = pos;
    while (end < input.length && input[end] !== ',' && input[end] !== '}' && input[end] !== ']') {
        end++;
    }
    return [input.substring(pos, end), end];
}
/**
 * Parse a C-string starting with '"' at `pos`.
 */
function parseMICString(input, pos) {
    if (input[pos] !== '"') {
        return ['', pos];
    }
    let result = '';
    let i = pos + 1;
    while (i < input.length) {
        if (input[i] === '\\') {
            i++;
            if (i < input.length) {
                switch (input[i]) {
                    case 'n':
                        result += '\n';
                        break;
                    case 't':
                        result += '\t';
                        break;
                    case '\\':
                        result += '\\';
                        break;
                    case '"':
                        result += '"';
                        break;
                    default:
                        result += input[i];
                        break;
                }
            }
        }
        else if (input[i] === '"') {
            return [result, i + 1];
        }
        else {
            result += input[i];
        }
        i++;
    }
    // Unterminated string
    return [result, i];
}
/**
 * Parse a tuple value { ... } starting at `pos`.
 */
function parseMITupleValue(input, pos) {
    if (input[pos] !== '{') {
        return [{}, pos];
    }
    const result = {};
    let i = pos + 1;
    while (i < input.length) {
        // Skip whitespace and commas
        while (i < input.length && (input[i] === ',' || input[i] === ' ')) {
            i++;
        }
        if (i >= input.length || input[i] === '}') {
            i++; // skip '}'
            break;
        }
        // Read key=value
        const eqIdx = input.indexOf('=', i);
        if (eqIdx === -1)
            break;
        const key = input.substring(i, eqIdx).trim();
        i = eqIdx + 1;
        const [value, newPos] = parseMIValue(input, i);
        result[key] = value;
        i = newPos;
    }
    return [result, i];
}
/**
 * Parse a list value [ ... ] starting at `pos`.
 * MI lists can be:
 *   - value-list:   ["a","b","c"]
 *   - result-list:  [name={...},name={...}]  (named items)
 */
function parseMIListValue(input, pos) {
    if (input[pos] !== '[') {
        return [[], pos];
    }
    const result = [];
    let i = pos + 1;
    while (i < input.length) {
        // Skip whitespace and commas
        while (i < input.length && (input[i] === ',' || input[i] === ' ')) {
            i++;
        }
        if (i >= input.length || input[i] === ']') {
            i++; // skip ']'
            break;
        }
        // Check if this is a named item (key=value) or just a value
        // Look ahead for '=' before the next ',' or ']' or '{' or '"'
        const lookAhead = findNextUnquoted(input, i, '=');
        const nextComma = findNextUnquoted(input, i, ',');
        const nextBracket = findNextUnquoted(input, i, ']');
        if (lookAhead !== -1 &&
            (nextComma === -1 || lookAhead < nextComma) &&
            (nextBracket === -1 || lookAhead < nextBracket) &&
            input[i] !== '"' && input[i] !== '{' && input[i] !== '[') {
            // Named item: key=value — parse as a tuple entry, push the value
            const key = input.substring(i, lookAhead).trim();
            i = lookAhead + 1;
            const [value, newPos] = parseMIValue(input, i);
            // For result-lists, wrap in object with key
            if (typeof value === 'object' && !Array.isArray(value)) {
                result.push(value);
            }
            else {
                result.push({ [key]: value });
            }
            i = newPos;
        }
        else {
            // Plain value
            const [value, newPos] = parseMIValue(input, i);
            result.push(value);
            i = newPos;
        }
    }
    return [result, i];
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Parse a C-string literal (standalone, for stream records).
 * Input should start with '"'.
 */
function parseCString(input) {
    const trimmed = input.trim();
    if (trimmed[0] !== '"') {
        return trimmed;
    }
    const [result] = parseMICString(trimmed, 0);
    return result;
}
/**
 * Find the position of `char` at the top level (not inside quotes/braces/brackets).
 * Returns -1 if not found.
 */
function findTopLevelComma(input, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < input.length; i++) {
        if (escaped) {
            escaped = false;
            continue;
        }
        const ch = input[i];
        if (ch === '\\' && inString) {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString)
            continue;
        if (ch === '{' || ch === '[') {
            depth++;
        }
        else if (ch === '}' || ch === ']') {
            depth--;
        }
        else if (ch === ',' && depth === 0) {
            return i;
        }
    }
    return -1;
}
/**
 * Find next occurrence of `target` char not inside a string literal.
 */
function findNextUnquoted(input, start, target) {
    let inString = false;
    let escaped = false;
    for (let i = start; i < input.length; i++) {
        if (escaped) {
            escaped = false;
            continue;
        }
        const ch = input[i];
        if (ch === '\\' && inString) {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (!inString && ch === target) {
            return i;
        }
    }
    return -1;
}
//# sourceMappingURL=miParser.js.map