declare function updatePageTranslations(): void;
declare function t(
  key: string,
  substitutions?: string | number | Array<string | number> | Record<string, string>
): string;
