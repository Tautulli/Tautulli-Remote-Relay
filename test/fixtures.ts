/**
 * Throwaway RSA key generated solely for these tests. It has never been used
 * for anything and secures nothing — it exists so the JWT-signing code path
 * runs against a syntactically valid PKCS#8 key.
 */
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCl3K/CsdoWY6mf
vqJTGB+dE8Rl8iNXaTMdb8j2aVE882pU3v7hsR/mlW20WHhE9tR0A/a2D0LgLrk1
jHrqfs2CkZz0UZNllEqCmY5jh68v1Q/74nC/2PlJeOl2VOY3vBKGRgbIljL8Fjtg
4+0Q8xTQvYj+aS5WQjRL0Lby/M04fwAlcwwFnSF7RZc2robYdjyF9nOt+Y+BBnkV
7wKw34xDdUKt5tmEwsHG4zE4cqtngUOq4pM4qYk7qSfE4tFy42ymWbSsDlaBiiQj
Zj5Yl5h2sw4CL1g8myGsqqWsT07kipLSqwOMeuwdCm7KXhQOcCDgc0tfZiuS2VX6
7VgY/N9hAgMBAAECggEAQdaApCGSBson1mPHLoHIZsMmdiswMS3untQ1Ku7yUuXy
wt7DwRXcqlyNcAWgNAvgmG7MW0dijfeuCB4L2pJcBGTFr0vEXRGIpB/NICAHf86s
6hjgFZ9MkQggcBrSSbRrjAY3Ah9w/JTcnCDNhSlgjV13CDn7LT1ZYfDm9jw4QCCx
9na/CGVZ3SJWWlJOM8zQ9iYm9lvjonYvJIb5OA5wkSnMe5XwfSDDEPju1lLLOzH3
iFAAayFH3bJWGHHqflkrfZYqjLj4feP6h9woYWRooNx501G1HPDBBtNv9xNZHKQ8
3t/KclzkXV6aceDc9KIDSd1g0GREwC5x2fTVc7j2YwKBgQDQDiLaKLKcLspMlUVY
LNq2exbGVSgDxwxS+pJ9P+CwBAqQtiPrA9kUDCXGcrmhWEnufITvpYLVEUZnskUV
sAKm1QFjiZ1VZRE05YGnlMq0fUxorO91CUHya4RLLL4rL5QNcuFRFLM1YnG/3E6t
KN132Ls35bdEola+oAV2Phod+wKBgQDMFW/CPSdujp+oZ9OfpmWOCI9gTybLqanB
J4IxnkkgavzWZOjzSRROdaxXKYzW41lz+EV0CIOQtHfNMAPYgNNrp7FdIGEtrlN8
lbgRQElvDLjaWMCkuII3L26bEVVqJX9Uqqx7YhzRjAujjeYpTdhLKUdsXQgDSns9
bBc3fOnFUwKBgAi23tzWYYzLJOwKQIpN7qdABpcuD+wAlVKQbjxSxZ15vduL1XtN
gPUnARoLyhyo7wfPLV5AR3eXLqS/QceDxMiqGVHK/M0L26mkh0a2o7rlmKK1w53a
UmnN+Q+RAzIZ3xClJCzaOhtdUThhCOaV1JjlegoAVCnKxulbGH94YG2rAoGAQIqO
+4jHjalBSMr9HEJNX6vJXBXsGQChFNrfy71ZNw1exJbJLRdxepawWChlyBfCVHCx
1k5S/VJ1iMikjrW/Jw6zgtYYpY+6C2519c606o/FbhgfZHiNhdJUUmoa7yTIrggD
4ElY/9QgYisgHPPncW2ujtClFhVaAETM2tmAPM0CgYEAkZuWFf6DuhG/x8Baje7V
4Mr0gm4WUj+tv+78qRPNWlhLEj5KEAu1vUu3nxWDbIT80W+qvqS27gIdQmo+4Z4+
4aRtYr9tq/JUK6/4nRmn526HxiUd+OAgmv72ativj9X/AY53//c3bHWgMr3z2VSh
uMGvX6YlMaeVl3+RSLQC828=
-----END PRIVATE KEY-----`;

export const TEST_SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'relay-test-project',
  client_email: 'relay-test@relay-test-project.iam.gserviceaccount.com',
  private_key: TEST_PRIVATE_KEY,
  token_uri: 'https://oauth2.googleapis.com/token',
});

/** A structurally plausible FCM registration token (length is what's validated). */
export const TEST_TOKEN =
  'dGVzdC1mY20tdG9rZW4:APA91b' + 'x'.repeat(140);

/** The envelope shape Tautulli actually sends. */
export const TEST_DATA = {
  encrypted: true,
  version: 2,
  cipher_text: 'Y2lwaGVyLXRleHQ=',
  nonce: 'bm9uY2U=',
  salt: 'c2FsdA==',
  server_id: 'test-server-uuid',
};
