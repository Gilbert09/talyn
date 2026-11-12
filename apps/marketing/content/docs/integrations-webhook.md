---
title: Webhook integration
description: Give an automation its own URL. A request to the URL starts a session or a task.
---

Webhook automations are in early access. Open **Integrations > Webhooks** to create one.

Each automation has its own URL. Your tool sends a request to that URL. Talyn then starts a session or a task on a repository you choose.

## Create an automation

1. Open **Integrations > Webhooks** and select **New automation**.
2. Choose a repository and write a prompt.
3. Choose what to start: a session (the default) or a task.
4. Add payload tests if you want (see below).

Talyn shows the URL and a signing secret once, when it creates the automation. Copy them then.
Talyn stores only a hash of the token, so it cannot show the URL again.

The URL has this form:

```
https://<api host>/api/v1/webhooks/in/<connection id>/<token>
```

The URL is a secret. Anyone who has it can start the automation. Keep it out of public code and logs.

Select **Rotate URL** to make a new URL and a new signing secret. The old URL stops working at once.
When you delete the automation, you delete its URL.

## Send a request

Send a `POST` with a JSON body of up to 1 MB. Talyn keeps a body that is not JSON as text.

| Answer | Meaning |
| --- | --- |
| `200` | Talyn received the request. The body is `{"received": true, "duplicate": false, "id": "..."}`. |
| `401` | The token is wrong, or the signature is not valid. |
| `404` | The URL is not known, or the feature is off for the workspace. |
| `413` | The body is over 1 MB. |
| `429` | The URL got more than 120 requests in one minute. |

## Sign a request

Signing is optional. Send the header `X-Talyn-Signature: sha256=<hex>`. The hex value is the HMAC-SHA256 of the raw request body, made with the signing secret.

When the header is there, it must be valid. When it is not there, Talyn checks only the token in the URL.

```bash
body='{"action":"opened","issue":{"title":"Login fails"}}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -X POST "$URL" \
  -H 'content-type: application/json' \
  -H "X-Talyn-Signature: sha256=$sig" \
  -d "$body"
```

## Delivery id

Send `X-Talyn-Delivery: <your id>` to name a request. A second request with the same id does nothing.

Without this header, Talyn uses a hash of the body. The same body sent twice in the same 10 minutes runs once.
Send a delivery id when you mean to send the same body more than once.

You can also send `X-Talyn-Event: <name>`. Talyn shows the name in the deliveries list. This header is optional.

## Payload tests

A payload test checks one value in the JSON body. Every test must pass for the automation to run. With no tests, every request runs it.

A path uses dots and array indexes. Examples: `issue.title`, `issue.labels[0].name`, `issue.labels.0.name`.
A path that is not in the body fails its test.

| Test | Passes when |
| --- | --- |
| **equals** | The value as text is exactly the value you give. |
| **contains** | The value as text contains your text, in any letter case. Or one item of an array equals your text, in any letter case. |
| **is present** | The path exists and is not null. |

## The prompt

Your prompt comes first. Below it, Talyn quotes the request body in a fenced block and marks it as untrusted.
Talyn cuts the quote to the first 16 KB. When the body is longer, Talyn adds a note.

Use `{{payload.<path>}}` in your prompt to point the agent at one value. Talyn puts that value in the fenced block. It never puts the value in the prompt text.

These placeholders go in the prompt text:

| Placeholder | Value |
| --- | --- |
| `{{repo}}` | The repository. |
| `{{webhook.delivery}}` | The delivery id. |
| `{{webhook.received_at}}` | The time Talyn received the request. |

A value that is not a plain identifier moves into the fenced block.

## Deliveries

Each automation lists the requests it received in the last 7 days. Each one shows an outcome: **Handled**, **No rule matched**, or **Failed**.

Open a delivery to see the body and the headers Talyn kept. Talyn never keeps `authorization`, `cookie` or signature headers.
Select **Replay** to run the automation again with that request.

## Limits and cost

An automation runs at most its hourly limit. The default is 5 runs an hour. You can change it.

Each session or task uses box-hours, like any other. Internet access in the sandbox is off unless you turn it on.

## Untrusted content

Whoever sends the webhook writes the body. Talyn tells the agent not to follow instructions in the body that conflict with your prompt or ask for secrets.
Keep the URL secret, and test the body for the values you expect.
