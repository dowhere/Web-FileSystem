# Docker 部署

镜像只包含 `server.js`、`src/` 和 `package.json`，无需安装 npm 依赖，使用命名卷保存数据。

## 快速开始

```bash
cd docker
cp .env.example .env        # 可选，按需修改端口和登录配置
docker compose up -d --build
```

打开 `http://localhost:5500`。查看日志、停止和更新：

```bash
docker compose logs -f
docker compose down
docker compose up -d --build   # 拉取代码后重新构建
```

首次启动的登录密码处理方式：

- `.env` 中设置了 `AUTH_PASSWORD`：使用该密码，并在每次启动时强制重置该账户的密码。
- `.env` 中 `AUTH_PASSWORD` 为空（默认）：首次启动生成随机密码，只在容器日志中显示一次：

  ```bash
  docker compose logs app | grep 'generated'
  ```

登录后可在 **设置 → 账户** 修改密码或管理用户。密码哈希等数据保存在命名卷 `web-filesystem-data` 中，重启容器不会丢失。

## 配置项

| 变量            | 默认值    | 说明                                         |
| --------------- | --------- | -------------------------------------------- |
| `WF_BIND`       | `0.0.0.0` | 宿主机监听地址；反代场景建议改为 `127.0.0.1` |
| `WF_PORT`       | `5500`    | 宿主机端口                                   |
| `AUTH_USER`     | `admin`   | 初始管理员用户名                             |
| `AUTH_PASSWORD` | 空        | 管理员密码；设置后每次启动都会强制使用该密码 |
| `BUCKET`        | `local`   | 本地存储桶名称                               |
| `NO_AUTH`       | `0`       | 设为 `1` 完全关闭登录，仅限可信网络使用      |
| `TRUST_PROXY`   | `0`       | 设为 `1` 时信任 `X-Forwarded-For`（仅在可信反代后开启） |

修改配置后执行 `docker compose up -d` 使设置生效。

## 数据与备份

文件、用户信息和分享签名密钥都在命名卷 `web-filesystem-data` 中。查看数据卷：

```bash
docker volume inspect web-filesystem-data
```

备份和恢复（在 `docker/` 目录下执行）：

```bash
# 备份到当前目录
docker run --rm -v web-filesystem-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/web-filesystem-data.tar.gz -C /data .

# 恢复（会覆盖卷内同名文件）
docker run --rm -v web-filesystem-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/web-filesystem-data.tar.gz -C /data
```

如果希望直接使用宿主机目录（例如仓库根目录的 `data/`），把 compose 中的

```yaml
volumes:
  - wf-data:/data
```

改成：

```yaml
volumes:
  - ../data:/data
```

并确保该目录对容器用户可写（镜像内用户 UID/GID 为 `1000:1000`，可使用 `sudo chown -R 1000:1000 ../data`）。使用宿主机目录后可以删除文件末尾的 `volumes:` 配置。

## 安全提示

- 默认映射 `0.0.0.0`，局域网内可访问。面向公网时请放在 HTTPS 反向代理之后，并把 `WF_BIND` 改为 `127.0.0.1`。
- 登录密码通过明文 HTTP 传输；不要把 `NO_AUTH=1` 与非回环地址一起使用。
- 容器以非 root 用户运行，只挂载 `/data`，并启用了 `no-new-privileges`。
- 首次构建需要能访问 Docker Hub 拉取 `node:24-alpine`；离线环境请先导入基础镜像。
