const Koa = require("koa")
const Router = require("koa-router")
const rp = require("request-promise")
const crypto = require("crypto")
const uuid = require("uuid")
const knex = require("knex")({
    client: "sqlite3",
    connection: {
        filename: "./development.db",
        timezone: "UTC"
    },
    acquireConnectionTimeout: 1000,
    useNullAsDefault: true
})

const app = new Koa()
const router = new Router({prefix: "/api/v1"})
const secretKey = crypto.randomBytes(32).hexSlice()

// Authorization control (generate UUID using OAuth response)
router
.get("/auth", async (ctx, next) => {
    ctx.assert(!!ctx.query.callback, 400)
    const token = crypto.randomBytes(32).hexSlice()
    ctx.cookies
    .set("callback", ctx.query.callback, {expires: new Date(Date.now() + 300000)})
    .set("token", crypto.createHmac("sha256", secretKey).update(token).digest("hex"), {expires: new Date(Date.now() + 300000)})
    ctx.redirect(`https://qiita.com/api/v2/oauth/authorize?client_id=${process.env.client_id}&scope=read_qiita&state=${token}`)
})
.get("/auth/callback", async (ctx, next) => {
    ctx.assert(!!ctx.cookies.get("token") && !!ctx.cookies.get("callback") && !!ctx.query.code && !!ctx.query.state, 400)
    ctx.assert(crypto.createHmac("sha256", secretKey).update(ctx.query.state).digest("hex") === ctx.cookies.get("token"), 400)
    ctx.cookies.set("token")
    await new Promise(resolve => setTimeout(resolve, 1000))
    await rp({
        method: "POST",
        uri: "https://qiita.com/api/v2/access_tokens",
        body: {
            client_id: process.env.client_id,
            client_secret: process.env.client_secret,
            code: ctx.query.code
        },
        json: true
    })
    .then(auth => {
        if (auth.client_id !== process.env.client_id) {
            ctx.throw(401)
        }
        return Promise.all([
            auth.token,
            rp({
                uri: "https://qiita.com/api/v2/authenticated_user",
                headers: {
                    "Authorization": `Bearer ${auth.token}`
                }
            })
        ])
    })
    .then(([token, user]) => Promise.all([
            user,
            rp({
                method: "DELETE",
                uri: `https://qiita.com/api/v2/access_tokens/${token}`
            })
        ])
    )
    .then(([user]) => {
        const token = uuid.v1()
        return Promise.all([
            token,
            knex("users").insert({id: user.id, token, source: "qiita" })
        ])
    })
    .then(([token]) => {
        ctx.redirect(`${ctx.cookies.get("callback")}?token=${token}`)
        ctx.cookies.set("callback")
    })
    .catch(err => {
        console.error(err)
        ctx.throw(500)
    })
    await next()
})

// Authentication
const checkAuth = async (ctx, next) => {
    // Token should be "Authorization: Bearer <UUID>"
    const auth = ctx.header.authorization
    ctx.assert(!!auth, 401)
    const token = auth.split(" ").pop()
    // Authentication (token to user)
    await knex.first("id").where("token", token).from("users")
    .then(user => {
        ctx.assert(!!user, 403)
        ctx.user = user.id
    })
    await next()
}

// Dislike API
router
.get("/:username/items/:id", checkAuth, async (ctx, next) => {
    // Get disliked status and dislike count from DB
    await knex.select("by_whom").where({id: ctx.params.id, state: true}).from("item_dislike")
    .then(users => {
        ctx.body = {
            disliked: users.map(_=>_.by_whom).includes(ctx.user),
            count: users.length
        }
    })
})
.post("/:username/items/:id", checkAuth, async (ctx, next) => {
    // Set disliked status and get new dislike count
    const {id, username} = ctx.params
    await knex.first("state").where({id, by_whom: ctx.user}).from("item_dislike")
    .then(disliked => {
        if (disliked === undefined) {
            return knex.transaction(trx => knex("item_dislike")
            .transacting(trx)
            .insert({id, username, by_whom: ctx.user, state: true})
            .then(trx.commit)
            .catch(e => {
                trx.rollback()
                throw e
            }))
        } else if (!disliked.state) {
            return knex.transaction(trx => knex("item_dislike")
            .transacting(trx)
            .where({id, by_whom: ctx.user})
            .update({state: true})
            .then(trx.commit)
            .catch(e => {
                trx.rollback()
                throw e
            }))
        } else {
            ctx.throw(405)
        }
    })
    .then(status => {
        ctx.body = {complete: true}
    })
})
.delete("/:username/items/:id", checkAuth, async (ctx, next) => {
    // Unset disliked status and get new dislike count
    const {id, username} = ctx.params
    await knex.first("state").where({id, by_whom: ctx.user}).from("item_dislike")
    .then(disliked => ctx.assert(!!disliked && disliked.state, 405))
    .then(() => knex.transaction(trx => knex("item_dislike")
        .transacting(trx)
        .where({id, by_whom: ctx.user})
        .update({state: false})
        .then(trx.commit)
        .catch(e => {
            trx.rollback()
            throw e
        })
    ))
    .then(status => {
        ctx.body = {complete: true}
    })
})

app
.use(async (ctx, next) => {
    ctx.req.setTimeout(10000)
    await next()
})
.use(router.routes())
.use(router.allowedMethods())
.listen(3000)
