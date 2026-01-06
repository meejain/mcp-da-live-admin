import { USER_AGENT, ADMIN_API_URL } from "./global.js";

async function parseResponseBody(response) {
  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    try {
      return await response.json();
    } catch (error) {
      // empty body or invalid JSON
      return {};
    }
  }
  return response.text();
}

export async function daAdminRequest(
  url,
  options = {}
) {
  const headers = {
    "User-Agent": USER_AGENT,
    ...options.headers,
  };

  if (process.env.DA_ADMIN_API_TOKEN) {
    headers["Authorization"] = `Bearer ${process.env.DA_ADMIN_API_TOKEN}`;
  }

  const init = {
    method: options.method || "GET",
    headers,
    body: options.body || undefined,
  };

  const response = await fetch(url, init);

  const responseBody = await parseResponseBody(response);

  if (!response.ok) {
    const errorMessage = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
    throw new Error(`${response.status}: ${errorMessage}`);
  }

  return responseBody;
}

export function daAdminResponseFormat(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export function formatURL(api, org, repo, path, ext) {
  // Remove leading slash from path if present
  let cleanPath = path.startsWith("/") ? path.slice(1) : path;
  
  // If extension is provided and path doesn't already end with it, add the extension
  if (ext) {
    const expectedExt = `.${ext}`;
    if (!cleanPath.endsWith(expectedExt)) {
      cleanPath = `${cleanPath}${expectedExt}`;
    }
  }
  
  return `${ADMIN_API_URL}/${api}/${org}/${repo}/${cleanPath}`;
}
