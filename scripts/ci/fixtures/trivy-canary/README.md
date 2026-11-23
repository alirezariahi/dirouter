A lockfile with lodash 4.17.4 (CVE-2019-10744, Critical). CI scans it first and requires the scan
to report a vulnerability, so a broken or silently passing scanner cannot let a release through.
Nothing installs or runs this package; the main scan skips this folder.
