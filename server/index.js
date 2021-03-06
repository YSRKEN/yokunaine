"use strict"

// require modules
const Koa = require("koa")
const Router = require("koa-router")
const Knex = require("knex")
const rp = require("request-promise")
const crypto = require("crypto")
const uuid = require("uuid")

// define constant values
const app = new Koa()
const router = new Router({prefix: "/api/v1"})
const secretKey = crypto.randomBytes(32).hexSlice()
const {client_id, client_secret, NODE_ENV} = process.env
const knex = Knex(require("./knexfile.js")[NODE_ENV || "development"])
const endpoint = "https://qiita.com/api/v2"

// routing
router
.get("/auth", async (ctx, next) => {
    // Authentication request
    const {callback} = ctx.query
    ctx.assert(callback, 400)
    const token = crypto.randomBytes(32).hexSlice()
    const expires = new Date(Date.now() + 300000)
    ctx.cookies
    .set("callback", callback, {expires})
    .set("token", crypto.createHmac("sha256", secretKey).update(token).digest("hex"), {expires})
    ctx.redirect(`${endpoint}/oauth/authorize?client_id=${client_id}&scope=read_qiita&state=${token}`)
})
.get("/auth/callback", async (ctx, next) => {
    // Authorization generate
    const {code, state} = ctx.query
    ctx.assert(ctx.cookies.get("callback") && code && state, 400)
    ctx.assert(crypto.createHmac("sha256", secretKey).update(state).digest("hex") === ctx.cookies.get("token"), 400)
    ctx.cookies.set("token")
    await new Promise(resolve => setTimeout(resolve, 500))
    await rp({
        method: "POST",
        uri: `${endpoint}/access_tokens`,
        body: {client_id, client_secret, code},
        json: true
    })
    .then(auth => {
        ctx.assert(auth.client_id === client_id, 500)
        return Promise.all([
            auth.token,
            rp({
                uri: `${endpoint}/authenticated_user`,
                headers: {"Authorization": `Bearer ${auth.token}`},
                json: true
            })
        ])
    })
    .then(([token, user]) => Promise.all([
        user,
        rp({
            method: "DELETE",
            uri: `${endpoint}/access_tokens/${token}`
        })
    ]))
    .then(([user]) => Promise.all([
        user.id,
        knex("users").first("id").where({id: user.id}),
    ]))
    .then(([id, exists]) => {
        const token = uuid.v1()
        if (!exists) {
            return Promise.all([
                token,
                knex("users").insert({id, token, revoked: false})
            ])
        } else {
            return Promise.all([
                token,
                knex("users").where({id}).update({revoked: false, token, updated_at: knex.fn.now()})
            ])
        }
    })
    .then(([token]) => {
        ctx.redirect(`${ctx.cookies.get("callback")}?token=${token}`)
        ctx.cookies.set("callback")
    })
    .catch(err => {
        console.error(err)
        ctx.throw(500)
    })
})
.delete("/auth/token/:token", async (ctx, next) => {
    const {token} = ctx.params
    await knex("users").first("id", "revoked").where("token", token)
    .then(user => {
        ctx.assert(user, 404)
        ctx.assert(!user.revoked, 400)
        return knex("users").where({id: user.id}).update({revoked: true, updated_at: knex.fn.now()})
    })
    .then(() => {
        ctx.body = {complete: true}
    })
})
.use("/:username/items/:id", async (ctx, next) => {
    // Authentication
    const auth = ctx.header.authorization
    ctx.assert(auth, 401)
    // Token should be "Authorization: Bearer <UUID>"
    const token = auth.replace(/^Bearer /, "")
    await knex("users").first("id").where({token, revoked: false})
    .then(user => {
        ctx.assert(user, 403)
        ctx.user = user.id
    })
    await next()
})
.get("/:username/items/:id", async (ctx, next) => {
    // Get disliked status and dislike count from DB
    await knex("item_dislike").select("by_whom").where({id: ctx.params.id, state: true})
    .then(users => {
        ctx.body = {
            disliked: users.map(_=>_.by_whom).includes(ctx.user),
            count: users.length
        }
    })
})
.post("/:username/items/:id", async (ctx, next) => {
    // Set disliked status
    const {id, username} = ctx.params
    await knex("item_dislike").first("state").where({id, by_whom: ctx.user})
    .then(disliked => {
        if (disliked === undefined) {
            return knex("item_dislike").insert({id, username, by_whom: ctx.user, state: true})
        } else if (!disliked.state) {
            return knex("item_dislike").where({id, by_whom: ctx.user}).update({state: true, updated_at: knex.fn.now()})
        } else {
            ctx.throw(405)
        }
    })
    .then(() => {
        ctx.body = {complete: true}
    })
})
.delete("/:username/items/:id", async (ctx, next) => {
    // Unset disliked status
    const {id, username} = ctx.params
    await knex("item_dislike").first("state").where({id, by_whom: ctx.user})
    .then(disliked => ctx.assert(!!disliked && disliked.state, 405))
    .then(() => knex("item_dislike").where({id, by_whom: ctx.user}).update({state: false, updated_at: knex.fn.now()}))
    .then(() => {
        ctx.body = {complete: true}
    })
})
.get("/statistics/dislike", async (ctx, next) => {
    await knex("item_dislike").count("*").where({state: true})
    .then(([result]) => {
        for (const count in result) {
            return ctx.body = {total: result[count]}
        }
    })
})

// Run API Server
app
.use(async (ctx, next) => {
    await next()
    const {method, ip, status, path, length, protocol, user} = ctx
    const {"user-agent": ua, "accept-language": lang} = ctx.headers
    knex("access_log").insert({method, ip, status, path, length, ua, lang, protocol, user})
    .then(() => {})
})
.use(async (ctx, next) => {
    // Set cors headers
    ctx.set("Access-Control-Allow-Origin", "*")
    ctx.set("Access-Control-Allow-Headers", "Authorization")
    ctx.set("Access-Control-Allow-Methods", "GET, PUT, DELETE")
    ctx.req.setTimeout(10000)
    try {
        await next()
    } catch (e) {
        ctx.status = e.status || 500
        ctx.type = "json"
        ctx.body = {error: e.message}
    }
})
.use(router.routes())
.use(router.allowedMethods({throw: true}))
.listen(3000)
