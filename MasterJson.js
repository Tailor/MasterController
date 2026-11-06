// The JSON a controller's response is written as.

export const CIRCULAR_MARKER = '[Circular Reference]';

/**
 * JSON.stringify that writes a real cycle as a marker instead of throwing.
 *
 * A cycle is a value inside itself, so only the values on the path from the root to the
 * current one are compared. An object that merely appears twice, such as one tag on many
 * cards, is written in full each time.
 *
 * JSON.stringify calls the replacer with `this` set to the object holding the key, and walks
 * depth first, so anything on the path above the holder is a branch it has finished with.
 *
 * @param {*} value
 * @returns {string|undefined} undefined only for what JSON.stringify gives undefined for
 */
export function stringifyResponse(value) {
    const path = [];
    return JSON.stringify(value, function replacer(key, current) {
        if (typeof current !== 'object' || current === null) return current;
        while (path.length && path[path.length - 1] !== this) path.pop();
        if (path.includes(current)) return CIRCULAR_MARKER;
        path.push(current);
        return current;
    });
}
