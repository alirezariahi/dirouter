import { configure } from '@testing-library/react';

// Lazily loaded parts of the app (command palette, charts, the log table) are separate modules.
// On a loaded CI runner their first import can take longer than the default one second that
// `findBy*` and `waitFor` allow, which made those tests fail without any real defect.
configure({ asyncUtilTimeout: 10_000 });
