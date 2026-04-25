import { describe, it, expect } from "vitest";
import { validateScriptPath as serverValidate } from "../../server/lib/validate-script-path.js";
import { validateScriptPath as clientValidate } from "../../client/lib/validate-script-path.js";
import { FIXTURES } from "./validate-script-path.test.js";

describe("validateScriptPath parity (T006)", () => {
  for (const fx of FIXTURES) {
    it(`${fx.label}: server == client`, () => {
      expect(clientValidate(fx.input)).toEqual(serverValidate(fx.input));
    });
  }
});
