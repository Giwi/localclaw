import { Component, inject, output, signal, input, type OnInit, type OnChanges, type SimpleChanges } from '@angular/core'
import { DatePipe } from '@angular/common'
import { ChatService, type BackgroundTask, type TaskExecution } from '../../services/chat.service'

@Component({
  selector: 'app-tasks-page',
  imports: [DatePipe],
  templateUrl: './tasks-page.component.html',
})
export class TasksPageComponent implements OnInit, OnChanges {
  private api = inject(ChatService)

  tasks = input<BackgroundTask[]>([])
  loadingTasks = input(false)
  onClose = output<void>()
  onTasksChanged = output<void>()

  selectedTask = signal<BackgroundTask | null>(null)
  executions = signal<TaskExecution[]>([])
  loadingExecs = signal(false)

  ngOnInit() {
    if (this.tasks().length > 0 && !this.selectedTask()) {
      this.selectTask(this.tasks()[0])
    }
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['tasks']) {
      const current = this.selectedTask()
      if (current) {
        const stillExists = this.tasks().find(t => t.id === current.id)
        if (!stillExists) {
          this.selectedTask.set(null)
          this.executions.set([])
        }
      }
      if (this.tasks().length > 0 && !this.selectedTask()) {
        this.selectTask(this.tasks()[0])
      }
    }
  }

  selectTask(task: BackgroundTask) {
    this.selectedTask.set(task)
    this.loadExecutions(task.id)
  }

  loadExecutions(taskId: string) {
    this.loadingExecs.set(true)
    this.api.getTaskLogs(taskId).subscribe({
      next: (res) => {
        this.executions.set(res.history ?? [])
        this.loadingExecs.set(false)
      },
      error: () => {
        this.executions.set([])
        this.loadingExecs.set(false)
      },
    })
  }

  runNow(taskId: string) {
    this.api.runBackgroundTask(taskId).subscribe({
      next: () => {
        this.loadExecutions(taskId)
        this.onTasksChanged.emit()
      },
    })
  }

  toggleTask(task: BackgroundTask) {
    this.api.toggleBackgroundTask(task.id, !task.enabled).subscribe({
      next: () => this.onTasksChanged.emit(),
    })
  }

  deleteTask(task: BackgroundTask) {
    this.api.deleteBackgroundTask(task.id).subscribe({
      next: () => {
        this.selectedTask.set(null)
        this.executions.set([])
        this.onTasksChanged.emit()
      },
    })
  }
}
