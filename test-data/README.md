# Test data

## Fixtures (`fixtures/`)

Synthetic or hand-crafted .fit files checked into version control. These are used by automated tests.

To generate synthetic .fit files:
- Use the `fit-file-parser` library's example file or create minimal valid FIT files
- Alternatively, record a short ride on any device and check it in (anonymised)

## Samples (`samples/`)

Real anonymised paired recordings used for integration and manual testing.
These should be gitignored if they are large or contain personal data.

To obtain samples:
1. Record the same ride on two devices simultaneously (e.g. a Garmin head unit and Wahoo head unit)
2. Export both .fit files
3. Anonymise by stripping out GPS coordinates if desired
4. Place in this directory

If samples are not checked in, tests that reference them will be skipped.
