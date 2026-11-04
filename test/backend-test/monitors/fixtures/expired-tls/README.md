This self-signed RSA certificate and private key were generated solely for the
loopback TLS regression in `test-tcp.js`. They have never authenticated a real
service. The private key is deliberately public test data and must never be
used outside these tests.

The certificate is valid from 2019-01-01 through 2020-01-01, with SANs for
`localhost` and `127.0.0.1`. The test trusts this exact fixture only so that the
real TLS implementation rejects its expired lifetime rather than an unknown CA
or hostname mismatch. No OpenSSL or Python package is needed to run the test.
