/** Never bypass the login in a release bundle, even if the env flag is set. */
export const developmentPreview =
  typeof __DEV__ !== "undefined" &&
  __DEV__ &&
  process.env.EXPO_PUBLIC_DEVELOPMENT_MODE === "true";
