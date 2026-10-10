// Pipeline do Nexo: a cada mudança no GitHub, o Jenkins
// baixa o código, gera a imagem, atualiza o app e confere se ele subiu.
pipeline {
  agent any

  // O Jenkins olha o GitHub a cada ~2 minutos procurando commits novos.
  // (Webhook não funciona aqui porque o GitHub não alcança a sua rede.)
  triggers { pollSCM('H/2 * * * *') }

  options {
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  environment {
    COMPOSE_PROJECT_NAME = 'nexo'
  }

  stages {
    stage('Preparar') {
      steps {
        // O .env (senhas) fica guardado no Jenkins, nunca no GitHub.
        withCredentials([file(credentialsId: 'nexo-env', variable: 'ENV_FILE')]) {
          sh 'cp "$ENV_FILE" .env'
        }
        sh 'docker version --format "Docker {{.Server.Version}}"'
      }
    }

    stage('Build') {
      steps {
        sh 'docker compose build app'
        // Confere a sintaxe de todos os arquivos JavaScript dentro da imagem nova.
        sh 'docker run --rm nexo-app sh -c "for f in src/*.js; do node --check \\$f || exit 1; done"'
      }
    }

    stage('Deploy') {
      steps {
        sh 'docker compose up -d --remove-orphans'
      }
    }

    stage('Verificar') {
      steps {
        // Espera até 60s o app responder no /health.
        sh '''
          for i in $(seq 1 30); do
            if docker compose exec -T app wget -qO- http://localhost:3000/health >/dev/null 2>&1; then
              echo "Nexo está no ar."
              exit 0
            fi
            sleep 2
          done
          echo "O app não respondeu. Últimos logs:"
          docker compose logs --tail 50 app
          exit 1
        '''
      }
    }
  }

  post {
    always {
      sh 'rm -f .env'
      // Remove imagens antigas que ficaram sem uso, para não lotar o disco.
      sh 'docker image prune -f >/dev/null || true'
    }
  }
}
