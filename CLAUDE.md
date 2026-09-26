# RadioIllustrator

Vite + TypeScript, no framework. `npm test` (vitest) and `npm run typecheck` before committing.
All user-facing text (interface, messages, documentation) is in English, American spelling.

## Writing rules for documentation

- Headings say what the section covers. Keep them short and concrete.
- Say what the software does and how to use it. Keep reasoning to the facts that explain a choice.
- One point per sentence. Fewer than 0.3 em dashes per 100 words.
- No "not X, but Y" and no "rather than", unless the reader would otherwise assume X.
- No closing morals, aphorisms or remarks about readers.
- Files, headers and the app do not lie, claim, say, want or know.
- Bold only for interface labels (exactly as the UI shows them) and for real warnings.
- Numbers instead of adjectives.
- Keep every safety statement complete (for example, that exported DICOM keeps patient data).
- Check every concrete claim (labels, defaults, file names) against the code.

Run `npm run prose` on any page you change.
