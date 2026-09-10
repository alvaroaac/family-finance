import { expect, it, vi } from "vitest";
import { createCaptureCategory } from "../src/createCaptureCategory";
const category = { id: "category-id", name: "Educação", isActive: true };
it("creates and selects the persisted category", async () => {
  const list = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([category]);
  const create = vi.fn().mockResolvedValue(undefined);
  expect(await createCaptureCategory(" Educação ", list, create)).toEqual(category);
  expect(create).toHaveBeenCalledWith("Educação");
});
it("selects an existing equivalent name without creating a duplicate", async () => {
  const create = vi.fn();
  expect(await createCaptureCategory("EDUCACAO", async () => [category], create)).toEqual(category);
  expect(create).not.toHaveBeenCalled();
});
it("recovers a successful write after its response was lost", async () => {
  const list = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([category]);
  expect(await createCaptureCategory("Educação", list, async () => { throw new Error("connection lost"); })).toEqual(category);
});
it("keeps an archived category archived and provides recovery guidance", async () => {
  const create = vi.fn();
  await expect(createCaptureCategory("Educação", async () => [{ ...category, isActive: false }], create)).rejects.toThrow("Restaure-a");
  expect(create).not.toHaveBeenCalled();
});
it("does not submit an empty name", async () => {
  const list = vi.fn(), create = vi.fn();
  await expect(createCaptureCategory("  ", list, create)).rejects.toThrow("Informe um nome");
  expect(list).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
it("propagates a failed create when reconciliation finds no category", async () => {
  await expect(createCaptureCategory("Educação", async () => [], async () => { throw new Error("Sem conexão"); })).rejects.toThrow("Sem conexão");
});
