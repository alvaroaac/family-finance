import { expect, it, vi } from "vitest";
import { verifyDevelopmentCode } from "../src/developmentSession";

it("never exchanges a code when the development flag is off", async () => {
  const verify = vi.fn();
  await expect(verifyDevelopmentCode({ enabled: false, email: "owner@example.test", code: "123456", verify })).rejects.toThrow("não está disponível");
  expect(verify).not.toHaveBeenCalled();
});
it("exchanges the code only for the configured account", async () => {
  const verify = vi.fn().mockResolvedValue({ error: null });
  await verifyDevelopmentCode({ enabled: true, email: "owner@example.test", code: " 123456 ", verify });
  expect(verify).toHaveBeenCalledTimes(1);
  expect(verify).toHaveBeenCalledWith({ email: "owner@example.test", token: "123456", type: "magiclink" });
});
it("rejects missing identity and malformed codes before making a request", async () => {
  const verify = vi.fn();
  for (const [email, code] of [[undefined, "123456"], ["owner@example.test", "abc123"], ["owner@example.test", "12345"]]) {
    await expect(verifyDevelopmentCode({ enabled: true, email, code: code!, verify })).rejects.toThrow("Confira");
  }
  expect(verify).not.toHaveBeenCalled();
});
it("handles expired or reused codes without displaying provider details", async () => {
  const verify = vi.fn().mockResolvedValue({ error: new Error("private provider details") });
  await expect(verifyDevelopmentCode({ enabled: true, email: "owner@example.test", code: "123456", verify })).rejects.toThrow("Código inválido ou expirado");
});
