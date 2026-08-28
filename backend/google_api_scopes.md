For least-privilege access, use:

| Purpose                                                          | OAuth scope                                                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| Read Gmail                                                       | `https://www.googleapis.com/auth/gmail.readonly`                 |
| Read/write calendar events                                       | `https://www.googleapis.com/auth/calendar.events`                |
| List available calendars                                         | `https://www.googleapis.com/auth/calendar.calendarlist.readonly` |
| Read/write selected or app-created Drive, Docs, and Sheets files | `https://www.googleapis.com/auth/drive.file`                     |

Copy/paste:

```text
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/calendar.calendarlist.readonly
https://www.googleapis.com/auth/drive.file
```

`drive.file` is Google’s recommended scope and works with the Drive, Docs, and Sheets APIs, but only for files the user selects, opens with, or creates through your app. [Google Drive scope guidance](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

If you need unrestricted access to every Drive file, replace `drive.file` with:

```text
https://www.googleapis.com/auth/drive
```

That broad Drive scope also authorizes Docs and Sheets operations, so separate `documents` and `spreadsheets` scopes aren’t necessary. It is a restricted scope and has substantially heavier verification requirements. [Google OAuth scope catalog](https://developers.google.com/identity/protocols/oauth2/scopes)

Optional additions:

- `https://www.googleapis.com/auth/calendar.freebusy` if you call the Calendar free/busy endpoint.
- Use `https://www.googleapis.com/auth/calendar` instead of the two narrower Calendar scopes only if you must manage calendars themselves, subscriptions, or sharing, not merely events. [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)
- `openid`, `userinfo.email`, and `userinfo.profile` are only needed for Google sign-in or user identity, not the data access above.

| API                    | Scope                                            | User-facing description                                                                                    |
| ---------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
|                        | `.../auth/calendar.calendarlist.readonly`        | See the list of Google calendars you’re subscribed to                                                      |
|                        | `.../auth/calendar.events.freebusy`              | See the availability on Google calendars you have access to                                                |
|                        | `.../auth/calendar.events.readonly`              | View events on all your calendars                                                                          |
|                        | `.../auth/gmail.readonly`                        | View your email messages and settings                                                                      |
|                        | `.../auth/drive.readonly`                        | See and download all your Google Drive files                                                               |
|                        | `.../auth/gmail.compose`                         | Manage drafts and send emails                                                                              |
|                        | `.../auth/drive.file`                            | See, edit, create, and delete only the specific Google Drive files you use with this app                   |
|                        | `.../auth/documents.readonly`                    | See all your Google Docs documents                                                                         |
|                        | `.../auth/documents`                             | See, edit, create, and delete all your Google Docs documents                                               |
|                        | `.../auth/spreadsheets.readonly`                 | See all your Google Sheets spreadsheets                                                                    |
|                        | `.../auth/calendar.events`                       | View and edit events on all your calendars                                                                 |
|                        | `.../auth/calendar.events.owned`                 | See, create, change, and delete events on Google calendars you own                                         |
|                        | `.../auth/calendar.events.owned.readonly`        | See the events on Google calendars you own                                                                 |
|                        | `.../auth/calendar.events.public.readonly`       | See the events on public calendars                                                                         |
|                        | `.../auth/calendar.freebusy`                     | View your availability in your calendars                                                                   |
|                        | `.../auth/spreadsheets`                          | See, edit, create, and delete all your Google Sheets spreadsheets                                          |
|                        | `.../auth/presentations.readonly`                | See all your Google Slides presentations                                                                   |
|                        | `.../auth/presentations`                         | See, edit, create, and delete all your Google Slides presentations                                         |
|                        | `.../auth/userinfo.email`                        | See your primary Google Account email address                                                              |
|                        | `.../auth/userinfo.profile`                      | See your personal info, including any personal info you've made publicly available                         |
|                        | `openid`                                         | Associate you with your personal info on Google                                                            |
| BigQuery API           | `.../auth/bigquery`                              | View and manage your data in Google BigQuery and see the email address for your Google Account             |
| BigQuery API           | `.../auth/cloud-platform`                        | See, edit, configure, and delete your Google Cloud data and see the email address for your Google Account. |
| BigQuery API           | `.../auth/bigquery.readonly`                     | View your data in Google BigQuery                                                                          |
| BigQuery API           | `.../auth/cloud-platform.read-only`              | View your data across Google Cloud services and see the email address of your Google Account               |
| BigQuery API           | `.../auth/devstorage.full_control`               | Manage your data and permissions in Cloud Storage and see the email address for your Google Account        |
| BigQuery API           | `.../auth/devstorage.read_only`                  | View your data in Google Cloud Storage                                                                     |
| BigQuery API           | `.../auth/devstorage.read_write`                 | Manage your data in Cloud Storage and see the email address of your Google Account                         |
| BigQuery API           | `.../auth/bigquery.insertdata`                   | Insert data into Google BigQuery                                                                           |
| Cloud Datastore API    | `.../auth/datastore`                             | View and manage your Google Cloud Datastore data                                                           |
| Cloud DNS API          | `.../auth/ndev.clouddns.readwrite`               | View and manage your DNS records hosted by Google Cloud DNS                                                |
| Cloud DNS API          | `.../auth/ndev.clouddns.readonly`                | View your DNS records hosted by Google Cloud DNS                                                           |
| Cloud Logging API      | `.../auth/logging.admin`                         | Administrate log data for your projects                                                                    |
| Cloud Logging API      | `.../auth/logging.read`                          | View log data for your projects                                                                            |
| Cloud Logging API      | `.../auth/logging.write`                         | Submit log data for your projects                                                                          |
| Cloud Monitoring API   | `.../auth/monitoring`                            | View and write monitoring data for all of your Google and third-party Cloud and API projects               |
| Cloud Monitoring API   | `.../auth/monitoring.read`                       | View monitoring data for all of your Google Cloud and third-party projects                                 |
| Cloud Monitoring API   | `.../auth/monitoring.write`                      | Publish metric data to your Google Cloud projects                                                          |
| Cloud Trace API        | `.../auth/trace.readonly`                        | Read Trace data for a project or application                                                               |
| Cloud Trace API        | `.../auth/trace.append`                          | Write Trace data for a project or application                                                              |
| Gmail API              | `https://mail.google.com/`                       | Read, compose, send, and permanently delete all your email from Gmail                                      |
| Gmail API              | `.../auth/gmail.modify`                          | Read, compose, and send emails from your Gmail account                                                     |
| Gmail API              | `.../auth/gmail.addons.current.action.compose`   | Manage drafts and send emails when you interact with the add-on                                            |
| Gmail API              | `.../auth/gmail.drafts.create`                   | Compose new draft emails                                                                                   |
| Gmail API              | `.../auth/gmail.addons.current.message.action`   | View your email messages when you interact with the add-on                                                 |
| Gmail API              | `.../auth/gmail.drafts.readonly`                 | Read your draft emails                                                                                     |
| Gmail API              | `.../auth/gmail.metadata`                        | View your email message metadata such as labels and headers, but not the email body                        |
| Gmail API              | `.../auth/gmail.insert`                          | Add emails into your Gmail mailbox                                                                         |
| Gmail API              | `.../auth/gmail.addons.current.message.metadata` | View your email message metadata when the add-on is running                                                |
| Gmail API              | `.../auth/gmail.addons.current.message.readonly` | View your email messages when the add-on is running                                                        |
| Gmail API              | `.../auth/gmail.send`                            | Send email on your behalf                                                                                  |
| Gmail API              | `.../auth/gmail.labels`                          | See and edit your email labels                                                                             |
| Gmail API              | `.../auth/gmail.settings.basic`                  | See, edit, create, or change your email settings and filters in Gmail                                      |
| Gmail API              | `.../auth/gmail.settings.sharing`                | Manage your sensitive mail settings, including who can manage your mail                                    |
| Gmail MCP API          | `.../auth/gmail.drafts`                          | Read, compose, send, update, and permanently delete your draft emails                                      |
| Google Calendar API    | `.../auth/calendar`                              | See, edit, share, and permanently delete all the calendars you can access using Google Calendar            |
| Google Calendar API    | `.../auth/calendar.acls`                         | See and change the sharing permissions of Google calendars you own                                         |
| Google Calendar API    | `.../auth/calendar.acls.readonly`                | See the sharing permissions of Google calendars you own                                                    |
| Google Calendar API    | `.../auth/calendar.readonly`                     | See and download any calendar you can access using your Google Calendar                                    |
| Google Calendar API    | `.../auth/calendar.app.created`                  | Make secondary Google calendars, and see, create, change, and delete events on them                        |
| Google Calendar API    | `.../auth/calendar.calendarlist`                 | See, add, and remove Google calendars you’re subscribed to                                                 |
| Google Calendar API    | `.../auth/calendar.calendars`                    | See and change the properties of Google calendars you have access to, and create secondary calendars       |
| Google Calendar API    | `.../auth/calendar.calendars.readonly`           | See the title, description, default time zone, and other properties of Google calendars you have access to |
| Google Calendar API    | `.../auth/calendar.settings.readonly`            | View your Calendar settings                                                                                |
| Service Management API | `.../auth/service.management`                    | Manage your Google API service configuration                                                               |
| Service Management API | `.../auth/service.management.readonly`           | View your Google API service configuration                                                                 |
| Service Management API | `.../auth/iam.test`                              | Test Identity and Access Management (IAM) Permissions                                                      |
