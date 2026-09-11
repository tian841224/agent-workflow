# zh-TW Translation

Use this file for EN／JA ↔ zh-TW translation, long-form localization, UI copy localization, or terminology-sensitive Traditional Chinese documents.

## Target outcome

A good translation preserves meaning, facts, placeholders, technical identifiers, and the source's level of formality while reading naturally to a Taiwan audience. Match the user's requested tone and domain rather than forcing one universal writing style.

Read [locale.md](locale.md) for baseline Taiwan wording. Use the references below only when the actual text requires them.

## Translation approach

Understand the whole passage before choosing terminology. Preserve numbers, dates, product names, code identifiers, placeholders such as `%1$s`, and formatting that carries meaning.

Translate for meaning rather than word order. Keep terminology consistent within the artifact, but do not mechanically replace words when context calls for a different Taiwan usage.

When the source is ambiguous and the ambiguity materially changes meaning, use surrounding context or authoritative domain usage first. Ask the user only when the ambiguity cannot be resolved safely and would change the deliverable.

Before delivery, check the parts that can realistically fail: omitted meaning, invented facts, mistranslated domain terms, broken placeholders, inconsistent terminology, unnatural Taiwan wording, or punctuation/format drift. Do not run a fixed multi-pass ritual when a short translation can be verified in one pass.

## References — load on demand

- `references/vocabulary.md` — broader Taiwan terminology and wording examples.
- `references/linguipedia-cross-strait.md` — large cross-strait vocabulary table; search only the uncertain term or domain section.
- `references/chinese-traditional.md` — Traditional Chinese language characteristics and regional distinctions.
- `references/english.md` — English source-language details when they affect interpretation.
- `references/japanese.md` — Japanese politeness, particles, and source-language details when they affect interpretation.
- `translation-challenges.md` — idioms, cultural references, wordplay, ambiguity, and other non-literal translation problems.
- `tools-resources.md` — external dictionaries and verification resources.

Do not load every reference by default. Start with the source text and `locale.md`, then retrieve only the reference needed to resolve an actual uncertainty.
