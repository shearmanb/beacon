import { describe, expect, it } from "vitest";
import { parseAge, parseProof } from "./bottle";

describe("parseAge", () => {
  it.each([
    ["THE REVERIES 10YR #5160 The Emptiness T8KE Reserve Cask 115.80 Proof", 10],
    ['THE REVERIES 8 Year Kentucky Single Barrel #27764 "SHUDDER" 122.30° pf', 8],
    ["The Reveries 17 Year Barrel Strength Bourbon", 17],
    ["Old Carter 10 Year Very Small Batch", 10],
    ["Some Bourbon 12 Years Old", 12],
    ["THE REVERIES: THE DEEP Kentucky Straight Bourbon", null],
  ])("%s → %s", (title, age) => expect(parseAge(title)).toBe(age));
});

describe("parseProof", () => {
  it.each([
    ["THE REVERIES 10YR #5160 The Emptiness T8KE Reserve Cask 115.80 Proof", 115.8],
    ['THE REVERIES 10 Year Single Barrel Bourbon #25033 "Meters & Fathoms" 124pf', 124],
    ['THE REVERIES 8 Year Kentucky Single Barrel #27764 "SHUDDER" 122.30° pf', 122.3],
    ["Old Carter 10 Year Very Small Batch Straight Bourbon 130 Proof", 130],
    ['THE REVERIES: 8 Year Single Barrel Barrel Proof Selection "Lucky 7"', null],
  ])("%s → %s", (title, proof) => expect(parseProof(title)).toBe(proof));
});
