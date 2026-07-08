import type { ReferenceImageProvider } from "../types";

/**
 * Mock reference-image provider: always returns null so the pipeline falls back
 * to generated imagery. Keeps offline/CI runs deterministic and network-free —
 * the real Wikimedia lookup only runs when providers aren't forced to mock.
 */
export function createMockReferenceProvider(): ReferenceImageProvider {
  return {
    name: "mock-reference",
    async findEntityImage() {
      return null;
    },
  };
}
