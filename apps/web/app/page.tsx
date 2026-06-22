import { redirect } from "next/navigation";

/**
 * The site root is just an entry point into the private app. Everything real
 * lives under the protected `(app)` route group, which guards itself
 * server-side. Send visitors straight to the dashboard; the guard will bounce
 * them to `/login` if they are not an authorized member of the Casa workspace.
 */
export default function HomePage() {
  redirect("/dashboard");
}
