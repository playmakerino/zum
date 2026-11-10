# Ad forms on ssshub: integration spec

This is for the ssshub developer. It covers every ad form that runs on GitHub Pages today, so each one can also run on ssshub. Both sites stay live side by side. The source of truth for each form is its HTML file in `forms/` (linked below). Read it for validation rules and the user-facing help text.

## 1. Form groups and names

| Group | Name on ssshub | Form id (`form` in the callback) | Source file |
|---|---|---|---|
| New product test | Any products · Device | `tc_form_1` | [prd_any_device.html](../forms/prd_any_device.html) |
| | Any products · Dropbox | `tc_form_4` | [prd_any_dropbox.html](../forms/prd_any_dropbox.html) |
| | Any products · Shopify | `tc_form_3` | [prd_any_shopify.html](../forms/prd_any_shopify.html) |
| | By print theme · Device | `tc_form_7` | [prd_theme_device.html](../forms/prd_theme_device.html) |
| | By print theme · Dropbox | `tc_form_8` | [prd_theme_dropbox.html](../forms/prd_theme_dropbox.html) |
| | By print theme · Shopify | `tc_form_2` | [prd_theme_shopify.html](../forms/prd_theme_shopify.html) |
| | By print · Device | `tc_form_9` | [prd_print_device.html](../forms/prd_print_device.html) |
| | By print · Dropbox | `tc_form_10` | [prd_print_dropbox.html](../forms/prd_print_dropbox.html) |
| | By print · Shopify | `tc_form_6` | [prd_print_shopify.html](../forms/prd_print_shopify.html) |
| Image test | Mockup images · Google Drive | `img_mockup_gdrive` | [img_mockup_gdrive.html](../forms/img_mockup_gdrive.html) |
| | Mockup images · Device | `img_mockup_device` | [img_mockup_device.html](../forms/img_mockup_device.html) |
| | Folder images · Google Drive | `img_folder_gdrive` | [img_folder_gdrive.html](../forms/img_folder_gdrive.html) |
| Video test | Video · Zumbamboo | `tc_vid_form` (kept for compatibility) | [vid_zumbamboo.html](../forms/vid_zumbamboo.html) |
| | Video · Scrubloop | see the Scrubloop workflow | [vid_scrubloop.html](../forms/vid_scrubloop.html) |

The form id is a stable key: the 9 New product test forms keep their old ids (`tc_form_N`) although their files were renamed to `prd_<group>_<source>.html`, so existing ssshub code keeps working. Do not show people's names in form titles; the image forms used to be called "Trang" and "Thảo", those names are gone.

## 2. Calling a form

- Base URL: `https://playmakerino.app.n8n.cloud/webhook/<path>`, method `POST`.
- Every request needs the header `x-auth-key` (the shared form password, ask the admin; it is not in this document). A wrong or missing key returns 403.
- Call from the browser on `https://ssshub.net`. n8n reads the `Origin` header (or `Referer`) and only sends the result callback (section 4) when it starts with `https://ssshub.net`.
- Always send `submitted_by_email` in the body (JSON field or multipart field). n8n returns it unchanged in the callback, so you can match the result to the user. The Video forms also use it to route the Telegram message.
- Webhook paths keep their old names on purpose (for example `tc-form-1-trang`, `tc-img-form-thao`). Do not expect them to match the new form names.

## 3. Request body per form

`meta` in a multipart request is a JSON string. File fields are binary parts.

| Form | Path | Type | Body |
|---|---|---|---|
| `tc_form_1` | `tc-embroidery-form-newcamp` | multipart | `meta` = `[{index:0, product_url, print_id}]`; `print_0` = print image; `img_0_<j>` = ad images |
| `tc_form_4` | `tc-form-4-newcamp` | JSON | `meta` = `[{index:0, product_url, print_id}]`; `print_images` = `{"0": <Dropbox link>}`; `ad_images` = `[{row:0, url, file_name}]` |
| `tc_form_3` | `tc-form-3-newcamp` | multipart | `meta` = `[{index, product_url, print_id, image_positions}]`; `print_<i>` = print image per row; `image_positions` = shared value |
| `tc_form_7` | `tc-form-7` | multipart | `ad_set_name`, `product_type`, `rows` = JSON `[{Print_ID, Product_url}]`; `img_<i>_<j>` = ad images of row i |
| `tc_form_8` | `tc-form-8` | JSON | `ad_set_name`, `product_type`, `rows` = `[{Print_ID, Product_url, ad_images:[<Dropbox link>]}]` |
| `tc_form_2` | `5a1c9e73-2f48-4d61-b3a0-7e9c1d4b62f8` | JSON | `ad_set_name`, `product_type`, `image_positions`, `rows` = `[{Print_ID, Product_url, Image_positions}]` |
| `tc_form_9` | `tc-form-9` | multipart | `meta` = `[{index, product_url, print_id}]` (one print_id for all rows); `print_image`; `img_<i>_<j>` |
| `tc_form_10` | `tc-form-10` | multipart | `meta` = `[{index, product_url, print_id, ad_images:[<Dropbox link>]}]`; `print_image_url` = Dropbox link |
| `tc_form_6` | `tc-form-6` | multipart | `meta` = `[{index, product_url, print_id, image_positions}]`; `image_positions` = shared value; `print_image` |
| `img_mockup_gdrive` | `tc-img-form-drive-pp` | JSON | `folder_id` (Google Drive folder id) |
| `img_mockup_device` | `tc-form-1-trang` | multipart | `img_0_<j>` = ad images, all of one print. File names `[PrintID-TypeID_MockupID].jpg` (normalize to NFC) |
| `img_folder_gdrive` | `tc-img-form-thao` | JSON | `folder_id` |
| Video · Zumbamboo | `01de568d-39af-4f07-a19b-085d1568150a` | JSON | `{folder_ids:[<one id>], submitted_by_email}`; send one request per folder |
| Video · Scrubloop | `9955ffab-18b9-4035-8f4c-c66d91411313` | JSON | `{folder_ids:[<one id>], submitted_by_email, product_url, texts:[...], headlines:[...]}` |

File naming rules, required fields and limits are in each form's guide panel ("Hướng dẫn điền form") and its `submitForm()` function.

## 4. Result callback (n8n to ssshub)

n8n sends `POST https://ssshub.net/api/v1/n8n/ads/status` with header `X-N8n-Webhook-Secret` (the shared secret already set up). The Telegram messages are still sent as before.

```json
{
  "status": "success | partial | error",
  "submitted_by_email": "...",
  "form": "<form id from section 1>",
  "workflow_id": "...",
  "execution_id": "...",
  "ad_account_id": "<digits, no act_ prefix>",
  "print_ids": ["..."],
  "product_ids": ["..."],
  "campaign_ids": ["..."],
  "ads_created": 3,
  "products": [
    { "print_id": "...", "product_id": null, "product_url": "...", "product_type": "...",
      "campaign_id": "...", "adset_id": "...", "status": "ok | partial | skipped | failed",
      "reason": "...", "detail": "...", "ads_created": 3 }
  ],
  "message": "Text to show the user (Vietnamese, one line per print)"
}
```

Extra fields on some forms:

- Google Drive forms and Video · Zumbamboo: `folder_id`, `folder_name`; `unmatched_files` when the whole folder was rejected.
- `img_mockup_gdrive` runs **in batches of 10 images, 10 minutes apart**, and sends **one callback per batch**: `batch = {offset, count, total, last, next_batch_failed}`. The submit is finished when `last` is `true`. If `next_batch_failed` is `true`, the rest of the folder was not processed and the user must submit the folder again.
- On the image forms, `products` is grouped per print. `product_url` is the collection link (`img_folder_gdrive`), the product link (`img_mockup_device`) or `null` (`img_mockup_gdrive`), and `product_id` is always `null`.

`reason` values: `ip_high`, `no_selected_mockup`, `no_images`, `product_not_found`, `shopify_error`, `positions_out_of_range` / `positions_out`, `no_type`, `unknown_type`, `no_print`, `no_copy_source`, `no_copy`, `campaign_failed`, `adset_failed`, `ads_failed`, `some_ads_failed`, `some_images_ip_high`, `no_ads`. Show `message` to the user; use `reason` only for filters and counts.

If an execution crashes before its last step, no callback is sent. Show "no result yet" after a timeout (about 30 minutes, or 2 hours for `img_mockup_gdrive` with many batches).

## 5. Dropbox forms (`tc_form_4`, `tc_form_8`, `tc_form_10`)

These forms use the **Dropbox Chooser** (`https://www.dropbox.com/static/api/2/dropins.js` with `data-app-key`). The Chooser only works on domains registered in the Dropbox app.

- Use the same app key as the GitHub Pages forms (it is public, in the `<script id="dropboxjs">` tag of `prd_any_dropbox.html`). The admin adds `ssshub.net` under Chooser/Saver domains in the Dropbox App Console.
- Call `Dropbox.choose({ linkType: 'direct', extensions: ['.jpg', '.jpeg', '.png'], ... })` and send the `link` values as shown in section 3.
- Direct links expire after 4 hours and break if the file is renamed. Tell users to submit right after picking.

n8n only downloads the links, so nothing changes on the n8n side.

## 6. Helper pages

- [type_ids.html](../forms/type_ids.html): the list of TypeID codes used in file names. The form guides link to it.
- [mockup_table.html](../forms/mockup_table.html): mockup table editor (internal).

Link to the GitHub Pages copies or rebuild them on ssshub.
