# Deck style modules

The Stage-3 migration partitions the original monolithic stylesheet without changing its CSS.
Each migrated top-level block starts with `/* @order NNNN */`, recording its position in the
original monolith. `scripts/build-deck-styles.mjs` reads every `.css` file below this directory,
sorts marked blocks by that number, removes the markers, and concatenates the original bytes.

New blocks do not need an order marker. Put new rules in a new `.css` file in the appropriate
module directory; unmarked blocks sort after all migrated blocks. Add an order marker only when
a rule must occupy a specific point in the legacy cascade.
