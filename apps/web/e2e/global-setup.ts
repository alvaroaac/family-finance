import { provisionMultiTenantFixtures } from "../../../e2e/lib/multi-tenant-fixtures";

export default async function globalSetup() {
  await provisionMultiTenantFixtures();
}
