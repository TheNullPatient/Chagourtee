'use strict';

/**
 * Shared helpers for message reactions.
 *
 * A room owns a small palette of emojis. The palette is stored in
 * `rooms.reaction_emojis` as a JSON array, while individual reactions live in
 * `message_reactions`, one row per user and emoji.
 */

const DEFAULT_REACTION_EMOJIS = Object.freeze(['👍', '❤️', '😂', '😮', '😢', '🔥']);
const MAX_REACTION_EMOJIS = 24;
// Long enough for family/flag/ZWJ sequences, short enough to reject text.
const MAX_REACTION_EMOJI_LENGTH = 32;

/**
 * Trims and validates a single emoji. Whitespace and control characters are
 * rejected so a room cannot turn reactions into arbitrary message text.
 */
function normalizeReactionEmoji(value) {
  if (typeof value !== 'string') return null;
  const emoji = value.trim();
  if (!emoji || emoji.length > MAX_REACTION_EMOJI_LENGTH) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(emoji)) return null;
  return emoji;
}

/**
 * Validates and de-duplicates a palette. Returns `{ ok, emojis }` or
 * `{ ok: false, error }`.
 */
function normalizeReactionEmojiList(value) {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'reactionEmojis must be an array' };
  }

  const emojis = [];
  for (const item of value) {
    const emoji = normalizeReactionEmoji(item);
    if (!emoji) {
      return { ok: false, error: 'reactionEmojis contains an invalid emoji' };
    }
    if (!emojis.includes(emoji)) emojis.push(emoji);
  }

  if (emojis.length === 0) {
    return { ok: false, error: 'reactionEmojis must contain at least one emoji' };
  }
  if (emojis.length > MAX_REACTION_EMOJIS) {
    return {
      ok: false,
      error: `reactionEmojis cannot contain more than ${MAX_REACTION_EMOJIS} emojis`,
    };
  }

  return { ok: true, emojis };
}

function serializeReactionEmojis(emojis) {
  return JSON.stringify(emojis);
}

/**
 * Reads a stored palette, falling back to the defaults if the value is
 * missing or corrupt (e.g. after a manual database edit).
 */
function parseReactionEmojis(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return [...DEFAULT_REACTION_EMOJIS];
  }

  try {
    const parsed = JSON.parse(value);
    const normalized = normalizeReactionEmojiList(parsed);
    return normalized.ok ? normalized.emojis : [...DEFAULT_REACTION_EMOJIS];
  } catch {
    return [...DEFAULT_REACTION_EMOJIS];
  }
}

module.exports = {
  DEFAULT_REACTION_EMOJIS,
  MAX_REACTION_EMOJIS,
  MAX_REACTION_EMOJI_LENGTH,
  normalizeReactionEmoji,
  normalizeReactionEmojiList,
  serializeReactionEmojis,
  parseReactionEmojis,
};
