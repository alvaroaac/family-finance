/** Exchanges a one-time code for a regular user session; never creates users. */
export async function verifyDevelopmentCode({
  enabled,
  email,
  code,
  verify,
}: {
  enabled: boolean;
  email: string | undefined;
  code: string;
  verify: (input: { email: string; token: string; type: "magiclink" }) => Promise<{ error: unknown }>;
}) {
  if (!enabled) throw new Error("A conexão de desenvolvimento não está disponível.");
  if (!email || !/^\d{6,8}$/.test(code.trim()))
    throw new Error("Confira o código de acesso desta instalação.");
  const { error } = await verify({ email, token: code.trim(), type: "magiclink" });
  if (error) throw new Error("Código inválido ou expirado. Solicite um novo código.");
}
