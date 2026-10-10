import { test } from "node:test";
import assert from "node:assert/strict";
import { internalToken, randomToken, seal, secretEquals, sign, unseal, verifySigned } from "./secret";

process.env.AUTH_SECRET = "test-secret";

test("signed values verify and tampering fails", () => {
  const s = sign("12345");
  assert.equal(verifySigned(s), "12345");
  assert.equal(verifySigned("12345"), null);
  assert.equal(verifySigned("99999" + s.slice(5)), null);
  assert.equal(verifySigned(s.slice(0, -1) + "x"), null);
  assert.equal(verifySigned(sign("a", "other")), null);
});

test("sealed tokens round trip and unsealed values pass through", () => {
  const sealed = seal("ya29.token");
  assert.notEqual(sealed, "ya29.token");
  assert.equal(unseal(sealed), "ya29.token");
  assert.equal(unseal("legacy-plain"), "legacy-plain");
  assert.equal(unseal("v1.garbage"), "");
  assert.equal(seal(""), "");
});

test("secretEquals and tokens", () => {
  assert.ok(secretEquals("abc", "abc"));
  assert.ok(!secretEquals("abc", "abd"));
  assert.ok(!secretEquals(undefined, "abc"));
  assert.ok(!secretEquals("", ""));
  assert.equal(randomToken().length >= 20, true);
  assert.equal(internalToken(), internalToken());
});
