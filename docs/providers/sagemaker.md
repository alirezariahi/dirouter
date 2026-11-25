[English](sagemaker.md) · [فارسی](sagemaker.fa.md)

# Amazon SageMaker

> Card 31.6.

| Field           | Value                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| type            | `openai-compatible`                                                                                                                                              |
| options.preset  | `sagemaker`                                                                                                                                                      |
| Default baseUrl | `https://runtime.sagemaker.<region>.amazonaws.com`                                                                                                               |
| Options         | `region` (else read from `baseUrl`), `containerModel` (the `model` the container expects, e.g. `tgi`), `controlUrl` (ListEndpoints URL override), `sessionToken` |
| Chat            | `POST {baseUrl}/endpoints/{endpoint}/invocations`; the model is the endpoint name and the container serves the OpenAI Messages API (TGI, LMI, vLLM)              |
| Model discovery | `SageMaker.ListEndpoints` (endpoints in service), a signed POST to `https://api.sagemaker.{region}.amazonaws.com/`                                               |
| API key         | `ACCESS_KEY_ID:SECRET_ACCESS_KEY` (optionally `:SESSION_TOKEN`), signed with SigV4 for the `sagemaker` service, as for Bedrock                                   |

Streaming (`invocations-response-stream`) is not carried yet: a streamed request is refused with a clear 400.

The connection test on the Providers page sends the model discovery request. Contract test: `pnpm --filter @dirouter/providers test` (`src/presets.test.ts`, against mock-provider). A run against the real Amazon SageMaker API needs an account and was not part of the automated tests.
