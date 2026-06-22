export type ImportSource = "minhas-financas" | "nubank";

export type ImportAdapter<TInput, TOutput> = {
  source: ImportSource;
  parse(input: TInput): Promise<TOutput>;
};
