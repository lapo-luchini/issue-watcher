// The browser build ships no type declarations of its own; it exports the same API as "vue".
declare module "vue/dist/vue.esm-browser.prod.js" {
  export * from "vue";
}
