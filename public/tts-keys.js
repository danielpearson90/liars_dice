// Shared vocabulary helpers for pre-generated text-to-speech clips.
// Imported by both the client (clip playback) and scripts/gen-tts.mjs
// (clip generation), so the keys and spoken text never drift apart.

const FACE_WORDS = ["", "one", "two", "three", "four", "five", "six"];
const NUM_WORDS = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
];
/** Spoken text for a bid, e.g. (4,4) -> "4 fours", (1,6) -> "1 six". */
export function bidText(quantity, face) {
  return `${NUM_WORDS[quantity]} ${FACE_WORDS[face]}${quantity === 1 ? "" : "s"}!`;
}

/** Stable clip key (and filename stem) for a bid, e.g. "bid-4-4". */
export function bidKey(quantity, face) {
  return `bid-${quantity}-${face}`;
}

// The two callable actions and what they say.
export const CALLS = {
  liar: "liar",
  "spot-on": "spot on",
};

/** Clip key for a call, e.g. "call-liar", "call-spot-on". */
export function callKey(call) {
  return `call-${call}`;
}

/**
 * Enumerate every clip to generate: bids for quantities 1..maxQuantity across
 * the six faces, plus the two calls. Returns { key, text } entries.
 */
export function vocabulary(maxQuantity) {
  const items = [];
  for (let q = 1; q <= maxQuantity; q++) {
    for (let f = 1; f <= 6; f++) {
      items.push({ key: bidKey(q, f), text: bidText(q, f) });
    }
  }
  for (const [call, text] of Object.entries(CALLS)) {
    items.push({ key: callKey(call), text });
  }
  return items;
}
