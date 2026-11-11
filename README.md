# 42 All In One

Extension tout-en-un pour faciliter la structuration de vos projets 42: header automatique, norminette intégrée, correction automatique de la norme et formatage en C et Python.

# Requirements
- **VS Code** 1.85 ou plus récent
- **Python 3** avec `pip`
- **Outils en ligne de commande** :
  ```bash
  pip install norminette c_formatter_42 black flake8
  ```
  - `norminette` : vérification de la norme C
  - `c_formatter_42` : correction automatique de la norme C
  - `black` : formatage Python
  - `flake8` : vérification de la norme Python
- Les commandes doivent être accessibles dans le `PATH`. Sinon, indique leur chemin dans les réglages `42AIO.c.command`, `42AIO.c.formatter.command`, `42AIO.python.black.command` et `42AIO.python.flake8.command` (ex. `python3 -m norminette`).
- Aucune autre extension VS Code n'est nécessaire.

Seuls les outils des langages utilisés sont nécessaires : pas besoin de `black` ni `flake8` pour un projet uniquement en C.

# Projets C
- **Header 42**
  - Inséré dans les nouveaux .c/.h et à la sauvegarde si absent.
  - Ligne `updated` mise à jour à la sauvegarde.
- **Norminette intégrée**
  - Analyse à l'ouverture/sauvegarde
  - Intégration vscode problems, status bar, side bar et inline
- **Formatter .c automatique**
  - Intégration `c_formatter_42`
  - Découpe des lignes de condition trop longues
  - Formatage à la sauvegarde

# Projets Python
- **Vérification de norme flake8**
- **Formatter .py automatique**
  - Intégration de `black formatter`
  - Découpe des lignes dont la largeur dépasse 79 chars

# Onglet 42
Accessible depuis l'icône 42 dans la barre latérale gauche.
- **Réglages**
  - Afficher les erreurs de norme : active/désactive norminette et flake8
  - Formatage automatique à la sauvegarde : active/désactive c_formatter_42 et Black
- **Erreurs de norme (C)**
  - Liste des erreurs par fichier, clic pour aller à la ligne
  - Bouton « Vérifier le workspace » : analyse tous les .c/.h du projet (respecte `.gitignore` dans un dépôt Git)


