# Test data

## Fixtures (`fixtures/`)

Reserved for synthetic or hand-crafted .fit files checked into version control. The current automated suite uses inline synthetic series and parser mocks, so this directory is empty.

To generate synthetic .fit files:
- Use the `fit-file-parser` library's example file or create minimal valid FIT files
- Alternatively, record a short ride on any device and check it in (anonymised)

## Samples (`samples/`)

Reserved for real anonymised paired recordings used for manual testing.
These should be gitignored if they are large or contain personal data.

To obtain samples:
1. Record the same ride on two devices simultaneously (e.g. a Garmin head unit and Wahoo head unit)
2. Export both .fit files
3. Anonymise by stripping out GPS coordinates if desired
4. Place in this directory

The automated suite does not depend on this directory.
