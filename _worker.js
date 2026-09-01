let token = "";

const PREFIX = '/gp/'
const DEFAULT_DOCKER_PREFIX = '/dp/'
let hub_host = 'registry-1.docker.io'
const auth_url = 'https://auth.docker.io'
// 分支文件使用jsDelivr镜像的开关，0为关闭，默认关闭
const Config = {
    jsdelivr: 0
}

const whiteList = [] // 白名单，路径里面有包含字符的才会通过，e.g. ['/username/']

/** @type {ResponseInit} */
const PREFLIGHT_INIT = {
    status: 204,
    headers: new Headers({
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
        'access-control-max-age': '1728000',
    }),
}


const exp1 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:releases|archive)\/.*$/i
const exp2 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i
const exp3 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:info|git-).*$/i
const exp4 = /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i
const exp5 = /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i
const exp6 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/tags.*$/i
const exp7 = /^(?:https?:\/\/)?api\.github\.com\/.*$/i
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const dockerPrefix = getDockerPrefix(env);
        if (url.pathname === dockerPrefix.slice(0, -1) || url.pathname.startsWith(dockerPrefix)) {
            return dockerFetchHandler(request, env, dockerPrefix).catch(err => makeRes('docker worker error:\n' + err.stack, 502))
        }
        if (isDockerRegistryRequest(url)) {
            return dockerFetchHandler(request, env).catch(err => makeRes('docker worker error:\n' + err.stack, 502))
        }
        if (url.pathname.startsWith(PREFIX)) {
            return fetchHandler(request, env).catch(err => makeRes('cfworker error:\n' + err.stack, 502))
        } else if (url.pathname !== '/') {
            let path_auth = false
            if (url.pathname.startsWith('/' + env.TOKEN)) {
                path_auth = true
                url.pathname = url.pathname.split('/' + env.TOKEN)[1];
            }
            
            let githubRawUrl = 'https://raw.githubusercontent.com';
            if (new RegExp(githubRawUrl, 'i').test(url.pathname)) {
                githubRawUrl += url.pathname.split(githubRawUrl)[1];
            } else {
                if (env.GH_NAME) {
                    githubRawUrl += '/' + env.GH_NAME;
                    if (env.GH_REPO) {
                        githubRawUrl += '/' + env.GH_REPO;
                        if (env.GH_BRANCH) githubRawUrl += '/' + env.GH_BRANCH;
                    }
                }
                githubRawUrl += url.pathname;
            }
            //console.log(githubRawUrl);

            // 初始化请求头
            const headers = new Headers();
            let authTokenSet = false; // 标记是否已经设置了认证token

            // 检查TOKEN_PATH特殊路径鉴权
            if (env.TOKEN_PATH) {
                const 需要鉴权的路径配置 = await ADD(env.TOKEN_PATH);
                // 将路径转换为小写进行比较，防止大小写绕过
                const normalizedPathname = decodeURIComponent(url.pathname.toLowerCase());

                //检测访问路径是否需要鉴权
                for (const pathConfig of 需要鉴权的路径配置) {
                    const configParts = pathConfig.split('@');
                    if (configParts.length !== 2) {
                        // 如果格式不正确，跳过这个配置
                        continue;
                    }

                    const [requiredToken, pathPart] = configParts;
                    const normalizedPath = '/' + pathPart.toLowerCase().trim();

                    // 精确匹配路径段，防止部分匹配绕过
                    const pathMatches = normalizedPathname === normalizedPath ||
                        normalizedPathname.startsWith(normalizedPath + '/');

                    if (pathMatches) {
                        const providedToken = url.searchParams.get('token');
                        if (!providedToken) {
                            return new Response('TOKEN不能为空', { status: 400 });
                        }

                        if (providedToken !== requiredToken.trim()) {
                            return new Response('TOKEN错误', { status: 403 });
                        }

                        // token验证成功，使用GH_TOKEN作为GitHub请求的token
                        if (!env.GH_TOKEN) {
                            return new Response('服务器GitHub TOKEN配置错误', { status: 500 });
                        }
                        headers.append('Authorization', `token ${env.GH_TOKEN}`);
                        authTokenSet = true;
                        break; // 找到匹配的路径配置后退出循环
                    }
                }
            }

            // 如果TOKEN_PATH没有设置认证，使用默认token逻辑
            if (!authTokenSet) {
                if (env.GH_TOKEN && env.TOKEN) {
                    if (env.TOKEN == url.searchParams.get('token') || path_auth) token = env.GH_TOKEN || token;
                    else token = url.searchParams.get('token') || token;
                } else token = url.searchParams.get('token') || env.GH_TOKEN || env.TOKEN || token;

                const githubToken = token;
                //console.log(githubToken);
                if (!githubToken || githubToken == '') {
                    return new Response('TOKEN不能为空', { status: 400 });
                }
                headers.append('Authorization', `token ${githubToken}`);
            }

            // 发起请求
            const response = await fetch(githubRawUrl, { headers });

            // 检查请求是否成功 (状态码 200 到 299)
            if (response.ok) {
                return new Response(response.body, {
                    status: response.status,
                    headers: response.headers
                });
            } else {
                const errorText = env.ERROR || '无法获取文件，检查路径或TOKEN是否正确。';
                // 如果请求不成功，返回适当的错误响应
                return new Response(errorText, { status: response.status });
            }

        } else {
            const envKey = env.URL302 ? 'URL302' : (env.URL ? 'URL' : null);
            if (envKey) {
                const URLs = await ADD(env[envKey]);
                const URL = URLs[Math.floor(Math.random() * URLs.length)];
                return envKey === 'URL302' ? Response.redirect(URL, 302) : fetch(new Request(URL, request));
            }
            //首页改成一个nginx伪装页
            return new Response(await nginx(), {
                headers: {
                    'Content-Type': 'text/html; charset=UTF-8',
                },
            });
        }
    }
};

async function nginx() {
    const text = `
	<!DOCTYPE html>
	<html>
	<head>
	<title>Welcome to nginx!</title>
	<style>
		body {
			width: 35em;
			margin: 0 auto;
			font-family: Tahoma, Verdana, Arial, sans-serif;
		}
	</style>
	</head>
	<body>
	<h1>Welcome to nginx!</h1>
	<p>If you see this page, the nginx web server is successfully installed and
	working. Further configuration is required.</p>
	
	<p>For online documentation and support please refer to
	<a href="http://nginx.org/">nginx.org</a>.<br/>
	Commercial support is available at
	<a href="http://nginx.com/">nginx.com</a>.</p>
	
	<p><em>Thank you for using nginx.</em></p>
	</body>
	</html>
	`
    return text;
}

async function ADD(envadd) {
    var addtext = envadd.replace(/[	|"'\r\n]+/g, ',').replace(/,+/g, ',');	// 将空格、双引号、单引号和换行符替换为逗号
    //console.log(addtext);
    if (addtext.charAt(0) == ',') addtext = addtext.slice(1);
    if (addtext.charAt(addtext.length - 1) == ',') addtext = addtext.slice(0, addtext.length - 1);
    const add = addtext.split(',');
    //console.log(add);
    return add;
}

function getDockerPrefix(env) {
    let prefix = env && env.DOCKER_PREFIX ? String(env.DOCKER_PREFIX).trim() : DEFAULT_DOCKER_PREFIX;
    if (!prefix.startsWith('/')) prefix = '/' + prefix;
    if (!prefix.endsWith('/')) prefix += '/';
    return prefix;
}

function isDockerRegistryRequest(url) {
    return url.pathname === '/v2' ||
        url.pathname.startsWith('/v2/') ||
        (url.pathname === '/token' && url.searchParams.has('service')) ||
        (url.pathname.startsWith('/token/') && url.searchParams.has('service'));
}

function routeByDockerHosts(host) {
    const routes = {
        quay: 'quay.io',
        gcr: 'gcr.io',
        'k8s-gcr': 'k8s.gcr.io',
        k8s: 'registry.k8s.io',
        ghcr: 'ghcr.io',
        cloudsmith: 'docker.cloudsmith.io',
        nvcr: 'nvcr.io',
        test: 'registry-1.docker.io',
    };

    if (host in routes) return [routes[host], false];
    return [hub_host, true];
}

async function dockerFetchHandler(request, env, dockerPrefix) {
    const getReqHeader = key => request.headers.get(key);
    const originalUrl = new URL(request.url);
    const prefixBase = dockerPrefix ? dockerPrefix.slice(0, -1) : '';
    const workers_url = `${originalUrl.origin}${prefixBase}`;

    let url = new URL(request.url);
    if (prefixBase && url.pathname === prefixBase) {
        url.pathname = '/';
    } else if (dockerPrefix && url.pathname.startsWith(dockerPrefix)) {
        url.pathname = '/' + url.pathname.slice(dockerPrefix.length);
    }

    const ns = url.searchParams.get('ns');
    const hostname = url.searchParams.get('hubhost') || originalUrl.hostname;
    const hostTop = hostname.split('.')[0];

    let checkHost;
    if (ns) {
        hub_host = ns === 'docker.io' ? 'registry-1.docker.io' : ns;
    } else {
        checkHost = routeByDockerHosts(hostTop);
        hub_host = checkHost[0];
    }

    url.hostname = hub_host;
    if (url.pathname === '/') {
        return new Response(await nginx(), {
            headers: {
                'Content-Type': 'text/html; charset=UTF-8',
            },
        });
    }
    if (url.pathname.startsWith('/v1/')) {
        return new Response('Docker registry proxy only', { status: 404 });
    }

    if (!/%2F/.test(url.search) && /%3A/.test(url.toString())) {
        url = new URL(url.toString().replace(/%3A(?=.*?&)/, '%3Alibrary%2F'));
    }

    if (url.pathname.includes('/token')) {
        const token_parameter = {
            headers: {
                Host: 'auth.docker.io',
                'User-Agent': getReqHeader('User-Agent'),
                Accept: getReqHeader('Accept'),
                'Accept-Language': getReqHeader('Accept-Language'),
                'Accept-Encoding': getReqHeader('Accept-Encoding'),
                Connection: 'keep-alive',
                'Cache-Control': 'max-age=0',
            },
        };
        setDockerAuthHeader(token_parameter.headers, env);
        const token_url = auth_url + url.pathname + url.search;
        return fetch(new Request(token_url, request), token_parameter);
    }

    if (hub_host == 'registry-1.docker.io' && /^\/v2\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname) && !/^\/v2\/library/.test(url.pathname)) {
        url.pathname = '/v2/library/' + url.pathname.split('/v2/')[1];
    }

    if (
        url.pathname.startsWith('/v2/') &&
        (
            url.pathname.includes('/manifests/') ||
            url.pathname.includes('/blobs/') ||
            url.pathname.includes('/tags/') ||
            url.pathname.endsWith('/tags/list')
        )
    ) {
        const v2Match = url.pathname.match(/^\/v2\/(.+?)(?:\/(manifests|blobs|tags)\/)/);
        const repo = v2Match ? v2Match[1] : '';
        if (repo) {
            const tokenUrl = `${auth_url}/token?service=registry.docker.io&scope=repository:${repo}:pull`;
            const tokenHeaders = {
                'User-Agent': getReqHeader('User-Agent'),
                Accept: getReqHeader('Accept'),
                'Accept-Language': getReqHeader('Accept-Language'),
                'Accept-Encoding': getReqHeader('Accept-Encoding'),
                Connection: 'keep-alive',
                'Cache-Control': 'max-age=0',
            };
            setDockerAuthHeader(tokenHeaders, env);
            const tokenRes = await fetch(tokenUrl, {
                headers: tokenHeaders,
            });
            const tokenData = await tokenRes.json();
            const dockerToken = tokenData.token;
            const parameter = dockerRequestParameters(request, getReqHeader, {
                Authorization: `Bearer ${dockerToken}`,
            });
            const original_response = await fetch(new Request(url, request), parameter);
            return dockerResponse(request, original_response, workers_url, hub_host);
        }
    }

    const parameter = dockerRequestParameters(request, getReqHeader);
    if (request.headers.has('Authorization')) {
        parameter.headers.Authorization = getReqHeader('Authorization');
    }

    const original_response = await fetch(new Request(url, request), parameter);
    return dockerResponse(request, original_response, workers_url, hub_host);
}

function setDockerAuthHeader(headers, env) {
    if (!env) return;
    if (env.DOCKER_AUTH) {
        headers.Authorization = `Basic ${env.DOCKER_AUTH}`;
        return;
    }

    const dockerPassword = env.DOCKER_TOKEN || env.DOCKER_PASSWORD;
    if (env.DOCKER_USERNAME && dockerPassword) {
        headers.Authorization = `Basic ${btoa(`${env.DOCKER_USERNAME}:${dockerPassword}`)}`;
    }
}

function dockerRequestParameters(request, getReqHeader, extraHeaders = {}) {
    const headers = {
        Host: hub_host,
        'User-Agent': getReqHeader('User-Agent'),
        Accept: getReqHeader('Accept'),
        'Accept-Language': getReqHeader('Accept-Language'),
        'Accept-Encoding': getReqHeader('Accept-Encoding'),
        Connection: 'keep-alive',
        'Cache-Control': 'max-age=0',
        ...extraHeaders,
    };

    if (request.headers.has('X-Amz-Content-Sha256')) {
        headers['X-Amz-Content-Sha256'] = getReqHeader('X-Amz-Content-Sha256');
    }

    return {
        headers,
        cacheTtl: 3600,
    };
}

async function dockerResponse(request, original_response, workers_url, baseHost) {
    const original_text = original_response.clone().body;
    const response_headers = original_response.headers;
    const new_response_headers = new Headers(response_headers);
    const status = original_response.status;

    if (new_response_headers.get('Www-Authenticate')) {
        const re = new RegExp(auth_url, 'g');
        new_response_headers.set('Www-Authenticate', response_headers.get('Www-Authenticate').replace(re, workers_url));
    }

    if (new_response_headers.get('Location')) {
        return dockerHttpHandler(request, new_response_headers.get('Location'), baseHost);
    }

    return new Response(original_text, {
        status,
        headers: new_response_headers,
    });
}

function dockerNewUrl(urlStr, base) {
    try {
        return new URL(urlStr, base);
    } catch (err) {
        return null;
    }
}

function dockerHttpHandler(req, pathname, baseHost) {
    const reqHdrRaw = req.headers;
    if (req.method === 'OPTIONS' && reqHdrRaw.has('access-control-request-headers')) {
        return new Response(null, PREFLIGHT_INIT);
    }

    const reqHdrNew = new Headers(reqHdrRaw);
    reqHdrNew.delete('Authorization');

    const urlObj = dockerNewUrl(pathname, 'https://' + baseHost);
    const reqInit = {
        method: req.method,
        headers: reqHdrNew,
        redirect: 'follow',
        body: req.body,
    };
    return dockerProxy(urlObj, reqInit);
}

async function dockerProxy(urlObj, reqInit) {
    const res = await fetch(urlObj.href, reqInit);
    const resHdrNew = new Headers(res.headers);

    resHdrNew.set('access-control-expose-headers', '*');
    resHdrNew.set('access-control-allow-origin', '*');
    resHdrNew.set('Cache-Control', 'max-age=1500');
    resHdrNew.delete('content-security-policy');
    resHdrNew.delete('content-security-policy-report-only');
    resHdrNew.delete('clear-site-data');

    return new Response(res.body, {
        status: res.status,
        headers: resHdrNew,
    });
}

/**
 * @param {any} body
 * @param {number} status
 * @param {Object<string, string>} headers
 */
function makeRes(body, status = 200, headers = {}) {
    headers['access-control-allow-origin'] = '*'
    return new Response(body, {status, headers})
}


/**
 * @param {string} urlStr
 */
function newUrl(urlStr) {
    try {
        return new URL(urlStr)
    } catch (err) {
        return null
    }
}


function checkUrl(u) {
    for (let i of [exp1, exp2, exp3, exp4, exp5, exp6, exp7]) {
        if (u.search(i) === 0) {
            return true
        }
    }
    return false
}

/**
 * @param {FetchEvent} e
 */
async function fetchHandler(req, env) {
    const urlStr = req.url
    const urlObj = new URL(urlStr)
    let path = urlObj.searchParams.get('q')
    if (path) {
        return Response.redirect('https://' + urlObj.host + PREFIX + path, 301)
    }
    // cfworker 会把路径中的 `//` 合并成 `/`
    path = urlObj.href.substr(urlObj.origin.length + PREFIX.length).replace(/^https?:\/+/, 'https://')
    if (path.search(exp1) === 0 || path.search(exp5) === 0 || path.search(exp6) === 0 || path.search(exp3) === 0 || path.search(exp4) === 0 || path.search(exp7) === 0) {
        return httpHandler(req, path, env)
    } else if (path.search(exp2) === 0) {
        if (Config.jsdelivr) {
            const newUrl = path.replace('/blob/', '@').replace(/^(?:https?:\/\/)?github\.com/, 'https://cdn.jsdelivr.net/gh')
            return Response.redirect(newUrl, 302)
        } else {
            path = path.replace('/blob/', '/raw/')
            return httpHandler(req, path, env)
        }
    } else if (path.search(exp4) === 0) {
        const newUrl = path.replace(/(?<=com\/.+?\/.+?)\/(.+?\/)/, '@$1').replace(/^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com/, 'https://cdn.jsdelivr.net/gh')
        return Response.redirect(newUrl, 302)
    }
}


/**
 * @param {Request} req
 * @param {string} pathname
 */
function httpHandler(req, pathname, env) {
    const reqHdrRaw = req.headers

    // preflight
    if (req.method === 'OPTIONS' &&
        reqHdrRaw.has('access-control-request-headers')
    ) {
        return new Response(null, PREFLIGHT_INIT)
    }

    const reqHdrNew = new Headers(reqHdrRaw)

    let urlStr = pathname
    let flag = !Boolean(whiteList.length)
    for (let i of whiteList) {
        if (urlStr.includes(i)) {
            flag = true
            break
        }
    }
    if (!flag) {
        return new Response("blocked", {status: 403})
    }
    if (urlStr.search(/^https?:\/\//) !== 0) {
        urlStr = 'https://' + urlStr
    }
    const urlObj = newUrl(urlStr)

    // 当目标为 api.github.com 时，自动注入 Authorization token
    if (env && urlObj && urlObj.hostname === 'api.github.com' && !reqHdrNew.has('authorization')) {
        const githubToken = urlObj.searchParams.get('token') || env.GH_TOKEN || env.TOKEN || '';
        if (githubToken) {
            reqHdrNew.set('Authorization', `token ${githubToken}`)
        }
    }

    /** @type {RequestInit} */
    const reqInit = {
        method: req.method,
        headers: reqHdrNew,
        redirect: 'manual',
        body: req.body
    }
    return proxy(urlObj, reqInit)
}


/**
 *
 * @param {URL} urlObj
 * @param {RequestInit} reqInit
 */
async function proxy(urlObj, reqInit) {
    const res = await fetch(urlObj.href, reqInit)
    const resHdrOld = res.headers
    const resHdrNew = new Headers(resHdrOld)

    const status = res.status

    if (resHdrNew.has('location')) {
        let _location = resHdrNew.get('location')
        if (checkUrl(_location))
            resHdrNew.set('location', PREFIX + _location)
        else {
            reqInit.redirect = 'follow'
            return proxy(newUrl(_location), reqInit)
        }
    }
    resHdrNew.set('access-control-expose-headers', '*')
    resHdrNew.set('access-control-allow-origin', '*')

    resHdrNew.delete('content-security-policy')
    resHdrNew.delete('content-security-policy-report-only')
    resHdrNew.delete('clear-site-data')

    return new Response(res.body, {
        status,
        headers: resHdrNew,
    })
}
