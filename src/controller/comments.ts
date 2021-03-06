/*
*
* 评论控制器
*
*/
// 有些模块只能用 commonjs
const geoip = require('geoip-lite')

import { BaseContext } from 'koa'
import { handleSuccess, IParams, handleError } from '../utils/handle'
import { sendMail } from '../utils/email'
import authIsVerified from '../utils/auth'
import Comment, { IComment } from '../model/comment'
import Article from '../model/article'


  // 更新当前所受影响的文章的评论聚合数据
const updateArticleCommentCount =  (post_ids: number[] = []) => {
    const postIds = [...new Set(post_ids)].filter(id => !!id)
    if (postIds.length) {
      Comment.aggregate([
        { $match: { state: 1, post_id: { $in: postIds } } },
        { $group: { _id: "$post_id", num_tutorial: { $sum: 1 } } }
      ])
        .then(counts => {
          if (counts.length === 0) {
            Article.update({ id: postIds[0] }, { $set: { 'meta.comments': 0 } })
          } else {
            counts.forEach(count => {
              Article.update({ id: count._id }, { $set: { 'meta.comments': count.num_tutorial } })
                .then(info => {
                  // console.log('评论聚合更新成功', info)
                })
                .catch(err => {
                  // console.warn('评论聚合更新失败', err)
                })
            })
          }
        })
        .catch(err => {
          console.warn('更新评论count聚合数据前，查询失败', err)
        })
    }
  }

// 邮件通知网站主及目标对象
const sendMailToAdminAndTargetUser = (
  comment: IComment,
  permalink: string
) => {
  sendMail({
    to: 'jkchao@foxmail.com',
    subject: '博客有新的留言',
    text: `来自 ${comment.author.name} 的留言：${comment.content}`,
    html: `<p> 来自 ${comment.author.name} 的留言：${comment.content}</p><br><a href="${permalink}" target="_blank">[ 点击查看 ]</a>`
  })
  if (!!comment.pid) {
    Comment.findOne({ id: comment.pid })
    .then(parentComment => {
      if (parentComment) {
        sendMail({
          to: (parentComment as IComment).author.email,
          subject: '你在jkchao.cn有新的评论回复',
          text: `来自 ${comment.author.name} 的评论回复：${comment.content}`,
          html: `<p> 来自${comment.author.name} 的评论回复：${comment.content}</p><br><a href="${permalink}" target="_blank">[ 点击查看 ]</a>`
        })
      }
    })
  }
}

export default class CommentController {

  // 获取评论列表
  public static async getComments (ctx: BaseContext) {

    const {
      current_page = 1,
      page_size = 20,
      keyword = '',
      post_id, state
    } = ctx.query

    let { sort = -1 } = ctx.query

    sort = Number(sort)

    // 过滤条件
    const options: {
      sort: { _id?: number, likes?: number }
      page: number
      limit: number
    } = {
      sort: { _id: sort },
      page: Number(current_page),
      limit: Number(page_size)
    }

    // 排序字段
    if ([1, -1].includes(sort)) {
      options.sort = { _id: sort }
    } else if (Object.is(sort, 2)) {
      options.sort = { likes: -1 }
    }

    // 查询参数
    const querys: {
      state?: number
      '$or'?: any
      post_id?: number
    } = {}

    // 查询各种状态
    if (state && ['0', '1', '2'].includes(state)) {
      querys.state = state
    }

    // 如果是前台请求，则重置公开状态和发布状态
    if (!authIsVerified(ctx.request)) {
      querys.state = 1
    }

    // 关键词查询
    if (keyword) {
      const keywordReg = new RegExp(keyword)
      querys.$or = [
        { 'content': keywordReg },
        { 'author.name': keywordReg },
        { 'author.email': keywordReg }
      ]
    }

    // 通过post-id过滤
    if (!Object.is(post_id, undefined)) {
      querys.post_id = post_id
    }

    // 请求评论
    const comments = await Comment
                            .paginate(querys, options)
                            .catch(err => ctx.throw(500, '服务器内部错误'))
    if (comments) {
      handleSuccess({
        ctx,
        message: "评论列表获取成功",
        result: {
          pagination: {
            total: comments.total,
            current_page: options.page,
            total_page: comments.pages,
            per_page: options.limit
          },
          data: comments.docs
        }
      })
    } else handleError({ ctx, message: "评论列表获取失败" })
  }

  // 发布评论
  public static async postComment (ctx: BaseContext) {
    const { body: comment } = ctx.request

    // 获取ip地址以及物理地理地址
    const ip = (ctx.req.headers['x-forwarded-for'] ||
      ctx.req.headers['x-real-ip'] ||
      ctx.req.connection.remoteAddress ||
      ctx.req.socket.remoteAddress ||
      ctx.req.connection.socket.remoteAddress ||
      ctx.req.ip ||
      ctx.req.ips[0]).replace('::ffff:', '')
    comment.ip = ip
    comment.agent = ctx.headers['user-agent'] || comment.agent

    const ip_location = geoip.lookup(ip)

    if (ip_location) {
      comment.city = ip_location.city,
      comment.range = ip_location.range,
      comment.country = ip_location.country
    }

    comment.likes = 0
    comment.author = JSON.parse(comment.author)

    let permalink = ''
    if (Number(comment.post_id) !== 0) {
      // 永久链接
      const article = await Article
                      .findOne({ id: comment.post_id }, '_id')
      if (article) permalink = `https://jkchao.cn/article/${article._id}`
    } else permalink = 'https://jkchao.cn/about'

    // 发布评论
    const res = await (
                        new Comment(comment)
                                .save()
                                .catch(err => ctx.throw(500, '服务器内部错误'))
                      ) as IComment | null
    if (res) {
      handleSuccess({ ctx, result: res, message: '评论发布成功' })
      // 发布成功后，向网站主及被回复者发送邮件提醒，并更新网站聚合
      sendMailToAdminAndTargetUser(res, permalink)
      updateArticleCommentCount([res.post_id])
    } else handleError({ ctx, message: '评论发布失败' })
  }

  // 删除评论
  public static async deleteComment (ctx: BaseContext) {
    const _id = ctx.params.id

    const post_ids = Array.of(Number(ctx.query.post_ids))

    const res = await Comment
                  .findByIdAndRemove(_id)
                  .catch(err => ctx.throw(500, '服务器内部错误'))
    if (res) {
      handleSuccess({ ctx, message: '评论删除成功' })
      updateArticleCommentCount(post_ids)
    }
    else handleError({ ctx, message: '评论删除失败' })
  }

  // 修改评论
  public static async putComment (ctx: BaseContext) {
    const _id = ctx.params.id
    let { post_ids, author } = ctx.request.body
    const { state } = ctx.request.body

    if (!state || !post_ids) {
      ctx.throw(401, '参数无效')
      return false
    }

    if (author) {
      author = JSON.parse(author)
    }

    post_ids = Array.of(Number(post_ids))

    const res = await Comment
                      .findByIdAndUpdate(_id, { ...ctx.request.body, author })
                      .catch(err => ctx.throw(500, '服务器内部错误'))
    if (res) {
      handleSuccess({ ctx, message: '评论状态修改成功' })
      updateArticleCommentCount(post_ids)
    }
    else handleError({ ctx, message: '评论状态修改失败' })
  }
}
