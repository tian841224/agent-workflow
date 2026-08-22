# Code Smell Baseline

When `reviewer.md`'s `Code quality and conventions` dimension flags a suspected item, come back here to check the definition and remediation direction; skip this file when there is no finding.

- **Mysterious Name**: the name doesn't convey the purpose or content of the function, variable, or type; rename it, and if no clear name can be found, check whether the design itself is vague.
- **Duplicated Code**: the same logic shape repeats across multiple hunks or files in this change; extract the appropriate shared logic.
- **Feature Envy**: a method mostly operates on another object's data; evaluate whether it should move to the object that owns that data.
- **Data Clumps**: the same fields or parameters keep being passed together; evaluate whether they should be encapsulated into a domain type.
- **Primitive Obsession**: a primitive or string stands in for a domain concept that deserves its own type; evaluate introducing a small dedicated type.
- **Repeated Switches**: the same `switch`/`if` cascade over a type recurs throughout the change; evaluate polymorphism or a shared map.
- **Shotgun Surgery**: one logical change forces edits across many scattered files; evaluate whether it should be consolidated into a single module.
- **Divergent Change**: the same file or module gets modified for multiple unrelated reasons; evaluate whether responsibilities should be split.
- **Speculative Generality**: an abstraction, parameter, or hook is added that the spec doesn't require; remove it or defer until the real need appears.
- **Message Chains**: callers depend on long `a.b().c().d()` navigation; evaluate whether the first object should hide the access path.
- **Middle Man**: a class or function mostly just forwards calls; evaluate whether it can be removed so callers reach the real target directly.
- **Refused Bequest**: a subclass or implementer ignores or overrides most of what it inherits; evaluate whether composition fits better.
