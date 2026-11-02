declare module "difflib" {
  export function unifiedDiff(
    before: string[],
    after: string[],
    options: { n: number; lineterm: string },
  ): string[];
}
