# Frozen before the test run (2026-10-08)

Final strategy: rolling+both (dev recall 99%).
Runner-up: trim+both (dev recall 98%; three-way tie with eunoe+both and eunoe+recall,
broken by best worst bucket — eunoe+recall 92%, eunoe+both 94%, trim+both 94% —
then smaller context at recall: trim+both 98k vs eunoe+both 102k).
Test arms: native, native+guide, full, rolling+both, trim+both.
No method code changes after this file was written.
