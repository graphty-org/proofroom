# The review page's session

`proofroom serve` prints the address of the review page with a session token after `#token=`:

```text
proofroom: open https://review.example:4800/#token=<token>
proofroom: server 3f9a0c2e71d4b85a: the page's session cookie is vr_session_3f9a0c2e71d4b85a
```

Open that exact URL. The page hands the token to the server once, and the server answers with a
session cookie for the page. From then on every request the page makes carries the cookie, images
included, so the token never travels in a request header and a plain `<img>` can show a picture.

## The cookie

- It is `HttpOnly` (the page's own scripts cannot read it), `SameSite=Strict`, and `Secure` when
  the page is served over HTTPS.
- Its name is `vr_session_<server id>`. The server id is made on the first start, kept in
  `<workDir>/state/server-id`, and printed beside the address. Browsers keep cookies per host, not
  per port, so several review servers on one machine (one you started, one an agent started, a
  local preview), each with its own work directory, keep their own cookies and never sign each
  other's pages out.
- Its value is derived from the token. Issuing a new token (delete `<workDir>/state/token` and
  restart) ends every cookie made from the old one: the page then asks for the new token. Paste
  the token, or the whole URL `serve` printed.
- A server restarted with the same token and work directory keeps its cookie's name and value, so
  a page left open across the restart keeps working without signing in again.
- It lasts a week, and the page renews it each time it opens.

## Scripts

A script can skip the cookie and send the token in the `x-review-token` header on each request, as
before:

```sh
curl -H "x-review-token: $TOKEN" https://review.example:4800/api/prs
```

## What is refused

- A request with neither a good cookie nor the token header gets `401`.
- A request that names another origin gets `403`, read or write, cookie or header. `SameSite` does
  not tell the ports of one host apart, so without this check a page on another port of the same
  machine could read the review data with your cookie. A same-origin `<img>` sends no `Origin`
  header; a request on the cookie that says it comes from another site (`Sec-Fetch-Site`) is
  refused too.
- Every write must come from the page's own origin.

## Images and pictures

The page asks for an image by its hash (`/api/blob/<sha256>`) and for a picture (a list row's
picture, plain, spotlit or zoomed to the change) by both images' hashes, the comparison's settings
and its kind
(`/api/pic/<baseline>-<capture>-<threshold>-<includeAA>-<kind>`, with `none` for a missing side).
An address names its content, so the server sends it with
`cache-control: private, max-age=31536000, immutable` and the browser asks for it once: showing a
list or a snapshot again fetches nothing. An image is still served only when its bytes hash to the
hash `results.json` gives. JSON answers are never cached.
