// Bun's bundler turns an imported asset into the URL it is served at.
declare module "*.svg" {
  const url: string;
  export default url;
}
