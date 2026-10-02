import { describe, it, expect } from "vitest";

import { slugifyBucketName } from "./accounts.js";

describe("slugifyBucketName", () => {
  it("lowercases and joins words with underscores", () => {
    expect(slugifyBucketName("Viagem 2027")).toBe("viagem_2027");
  });

  it("removes accents", () => {
    expect(slugifyBucketName("Independência Financeira")).toBe(
      "independencia_financeira",
    );
    expect(slugifyBucketName("Educação das crianças")).toBe(
      "educacao_das_criancas",
    );
  });

  it("collapses runs of non-alphanumeric characters and trims them", () => {
    expect(slugifyBucketName("  Casa -- nova!  ")).toBe("casa_nova");
    expect(slugifyBucketName("_reserva_")).toBe("reserva");
  });

  it("yields an empty slug when the name has no letters or digits", () => {
    expect(slugifyBucketName("")).toBe("");
    expect(slugifyBucketName("  !!! ")).toBe("");
  });
});
